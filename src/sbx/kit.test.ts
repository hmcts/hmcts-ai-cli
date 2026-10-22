import { describe, expect, it } from "vitest";
import {
  allowedSourcesDecision,
  daemonMismatch,
  KIT_IMAGE,
  KIT_REGISTRY,
  KIT_REPOSITORY,
  kitComparable,
  kitStaleness,
  parseIndexDigests,
  parseKitRecord,
  parseSandboxNames,
  parseSbxVersion,
  type SbxVersion,
  sizeMib,
  staleKitMessage,
  volumeSizeDecision
} from "./kit.js";

const DIGEST_ARM = "sha256:aaaa";
const DIGEST_AMD = "sha256:bbbb";
const DIGEST_INDEX = "sha256:cccc";

const version = (client: string | null, server: string | null, state: string | null): SbxVersion => ({ client, server, state });

describe("the kit's coordinates", () => {
  it("should name the published cft-workspace kit and its ACR coordinates", () => {
    // Act / Assert
    expect(KIT_REGISTRY).toBe("hmctsprod");
    expect(KIT_REPOSITORY).toBe("cft-workspace/sbx:latest");
  });
});

describe("parseSbxVersion", () => {
  it("should read the versions and the daemon state out of the JSON", () => {
    // Act
    const parsed = parseSbxVersion(JSON.stringify({ client: { version: "v0.3.0" }, server: { version: "v0.2.9", state: "running" } }));

    // Assert
    expect(parsed).toEqual({ client: "v0.3.0", server: "v0.2.9", state: "running" });
  });

  it.each<[string, string]>([
    ["output that is not JSON at all", "sbx: command gated"],
    ["an empty answer", ""],
    ["JSON of the wrong shape", JSON.stringify({ client: 3, server: [] })]
  ])("should read nothing out of %s", (_name, stdout) => {
    // Act / Assert
    expect(parseSbxVersion(stdout)).toEqual({ client: null, server: null, state: null });
  });
});

describe("daemonMismatch", () => {
  it("should name both versions and tell the engineer to restart the daemon themselves", () => {
    // Act
    const message = daemonMismatch(version("v0.3.0", "v0.2.9", "running"));

    // Assert
    expect(message).toContain("the sbx CLI is v0.3.0 but the sandboxd it talks to is still v0.2.9");
    expect(message).toContain("sbx daemon restart");
    expect(message).toContain("stops every running sandbox");
  });

  it.each<[string, SbxVersion]>([
    ["the versions match", version("v0.3.0", "v0.3.0", "running")],
    ["the daemon is not running", version("v0.3.0", "v0.2.9", "stopped")],
    ["there is no state", version("v0.3.0", "v0.2.9", null)],
    ["the client version is unreadable", version(null, "v0.2.9", "running")],
    ["the server version is unreadable", version("v0.3.0", null, "running")],
    ["a version does not look like one", version("dev", "v0.2.9", "running")],
    ["the server version does not look like one", version("v0.3.0", "snapshot", "running")]
  ])("should say nothing when %s", (_name, parsed) => {
    // Act / Assert
    expect(daemonMismatch(parsed)).toBeNull();
  });
});

describe("allowedSourcesDecision", () => {
  it.each<[string, string | null, boolean, string]>([
    ["sbx's default, which is Docker Hub alone", '["docker.io/"]', true, '["docker.io/","hmctsprod.azurecr.io/cft-workspace/"]'],
    ["a setting that cannot be read", null, true, '["docker.io/","hmctsprod.azurecr.io/cft-workspace/"]'],
    ["output that is not JSON", "docker.io/", true, '["docker.io/","hmctsprod.azurecr.io/cft-workspace/"]'],
    ["a list that is not of strings", "[1,2]", true, '["docker.io/","hmctsprod.azurecr.io/cft-workspace/"]'],
    ["the kit source already allowed", '["docker.io/","hmctsprod.azurecr.io/cft-workspace/"]', false, '["docker.io/","hmctsprod.azurecr.io/cft-workspace/"]'],
    ["another source as well", '["ghcr.io/"]', true, '["ghcr.io/","hmctsprod.azurecr.io/cft-workspace/"]']
  ])("should decide from %s", (_name, current, needed, value) => {
    // Act / Assert
    expect(allowedSourcesDecision(current)).toEqual({ needed, value });
  });

  it("should keep the sources already there, so nobody else's kit stops working", () => {
    // Act
    const { value } = allowedSourcesDecision('["docker.io/","ghcr.io/"]');

    // Assert
    expect(JSON.parse(value)).toEqual(["docker.io/", "ghcr.io/", "hmctsprod.azurecr.io/cft-workspace/"]);
  });
});

describe("sizeMib", () => {
  it.each<[string, string | null, number]>([
    ["gibibytes", "40g", 40960],
    ["mebibytes", "512m", 512],
    ["kibibytes", "2048k", 2],
    ["bare bytes", "10485760", 10],
    ["a capital suffix", "40G", 40960],
    ["surrounding space", " 40g ", 40960],
    ["nothing", null, 0],
    ["something unparseable", "lots", 0]
  ])("should read %s", (_name, value, expected) => {
    // Act / Assert
    expect(sizeMib(value)).toBe(expected);
  });
});

describe("volumeSizeDecision", () => {
  it.each<[string, string | null, boolean]>([
    ["sbx's 10g default", "10g", true],
    ["nothing set", null, true],
    ["something unparseable", "big", true],
    ["exactly 40g", "40g", false],
    ["more than 40g, chosen by someone for their own sandboxes", "80g", false],
    ["40960m, the same size stated differently", "40960m", false]
  ])("should decide from %s", (_name, current, needed) => {
    // Act / Assert
    expect(volumeSizeDecision(current).needed).toBe(needed);
  });

  it("should never lower a size someone else raised", () => {
    // Act / Assert
    expect(volumeSizeDecision("100g")).toEqual({ needed: false, reason: "new sandboxes' /var/lib/docker volume is already 100g" });
  });

  it("should say what it is raising from", () => {
    // Act / Assert
    expect(volumeSizeDecision(null).reason).toContain("was unset");
  });
});

describe("parseSandboxNames", () => {
  it("should read the names out of the table, skipping the header", () => {
    // Act
    const names = parseSandboxNames("NAME       STATE     KIT\ncft-workspace  running  sbx:latest\nhai-pcs-api-1234  stopped  sbx:latest\n");

    // Assert
    expect(names).toEqual(["cft-workspace", "hai-pcs-api-1234"]);
  });

  it.each<[string, string]>([
    ["only a header", "NAME  STATE\n"],
    ["nothing at all", ""]
  ])("should find no names in %s", (_name, stdout) => {
    // Act / Assert
    expect(parseSandboxNames(stdout)).toEqual([]);
  });
});

describe("parseKitRecord", () => {
  it("should read the kit it was created from and the digest it recorded", () => {
    // Act
    const record = parseKitRecord(JSON.stringify({ kits: [KIT_IMAGE], image_digest: DIGEST_ARM, state: "running" }));

    // Assert
    expect(record).toEqual({ createdFrom: KIT_IMAGE, digest: DIGEST_ARM });
  });

  it.each<[string, string, { createdFrom: string | null; digest: string | null }]>([
    ["no kits at all", JSON.stringify({ image_digest: DIGEST_ARM }), { createdFrom: null, digest: DIGEST_ARM }],
    ["kits of the wrong type", JSON.stringify({ kits: "one", image_digest: DIGEST_ARM }), { createdFrom: null, digest: DIGEST_ARM }],
    ["no digest", JSON.stringify({ kits: [KIT_IMAGE] }), { createdFrom: KIT_IMAGE, digest: null }]
  ])("should read what it can from a spec with %s", (_name, stdout, expected) => {
    // Act / Assert
    expect(parseKitRecord(stdout)).toEqual(expected);
  });

  it("should read nothing from output that is not JSON", () => {
    // Act / Assert
    expect(parseKitRecord("no such sandbox")).toBeNull();
  });
});

describe("kitComparable", () => {
  it.each<[string, Parameters<typeof kitComparable>[0], boolean, string]>([
    ["a sandbox on the published kit", { createdFrom: KIT_IMAGE, digest: DIGEST_ARM }, true, "created from"],
    ["a spec that could not be read", null, false, "could not be read"],
    ["a locally built kit", { createdFrom: "/home/linus/Work/solirius/hmcts/.devcontainer/sbx", digest: DIGEST_ARM }, false, "local kit"],
    ["someone else's kit", { createdFrom: "docker.io/library/ubuntu", digest: DIGEST_ARM }, false, "not hmctsprod"],
    ["an unrecorded kit", { createdFrom: null, digest: DIGEST_ARM }, false, "an unrecorded kit"],
    ["no digest to compare", { createdFrom: KIT_IMAGE, digest: null }, false, "records no image digest"],
    ["an empty digest", { createdFrom: KIT_IMAGE, digest: "" }, false, "records no image digest"]
  ])("should report %s", (_name, record, yes, reason) => {
    // Act
    const decision = kitComparable(record);

    // Assert
    expect(decision.yes).toBe(yes);
    expect(decision.reason).toContain(reason);
  });
});

describe("kitStaleness", () => {
  it.each<[string, Parameters<typeof kitStaleness>[0], boolean]>([
    ["the digests match", { recorded: DIGEST_ARM, latest: DIGEST_ARM, indexDigests: null }, false],
    ["the published digest could not be read", { recorded: DIGEST_ARM, latest: null, indexDigests: null }, false],
    ["the published digest came back empty", { recorded: DIGEST_ARM, latest: "", indexDigests: null }, false],
    ["the index could not be read", { recorded: DIGEST_ARM, latest: DIGEST_INDEX, indexDigests: null }, false],
    ["the recorded digest is one arch of the index", { recorded: DIGEST_ARM, latest: DIGEST_INDEX, indexDigests: [DIGEST_ARM, DIGEST_AMD] }, false],
    ["the recorded digest is in no published index", { recorded: "sha256:old", latest: DIGEST_INDEX, indexDigests: [DIGEST_ARM, DIGEST_AMD] }, true],
    ["the index is published but empty", { recorded: DIGEST_ARM, latest: DIGEST_INDEX, indexDigests: [] }, true]
  ])("should report not stale unless it is sure: %s", (_name, input, stale) => {
    // Act / Assert
    expect(kitStaleness(input).stale).toBe(stale);
  });

  it("should say why, so a false positive can be told from a real one", () => {
    // Act
    const sure = kitStaleness({ recorded: "sha256:old", latest: DIGEST_INDEX, indexDigests: [DIGEST_ARM] });
    const unsure = kitStaleness({ recorded: DIGEST_ARM, latest: DIGEST_INDEX, indexDigests: null });

    // Assert
    expect(sure.reason).toContain("is not part of it");
    expect(unsure.reason).toContain("says nothing");
  });
});

describe("staleKitMessage", () => {
  it("should name the sandbox and what recreating it costs", () => {
    // Act
    const message = staleKitMessage("hai-hmcts-1234");

    // Assert
    expect(message).toContain("sbx rm -f hai-hmcts-1234");
    expect(message).toContain("build caches");
  });
});

describe("parseIndexDigests", () => {
  it("should read the children of a manifest list", () => {
    // Act
    const digests = parseIndexDigests(JSON.stringify({ manifests: [{ digest: DIGEST_ARM }, { digest: DIGEST_AMD }] }));

    // Assert
    expect(digests).toEqual([DIGEST_ARM, DIGEST_AMD]);
  });

  it("should drop entries with no digest rather than report them as children", () => {
    // Act / Assert
    expect(parseIndexDigests(JSON.stringify({ manifests: [{ digest: DIGEST_ARM }, {}, { digest: 7 }] }))).toEqual([DIGEST_ARM]);
  });

  it.each<[string, string]>([
    ["a single-arch manifest with no list in it", JSON.stringify({ schemaVersion: 2, config: {} })],
    ["output that is not JSON", "ERROR: manifest unknown"]
  ])("should answer null, which reads as cannot tell, for %s", (_name, stdout) => {
    // Act / Assert
    expect(parseIndexDigests(stdout)).toBeNull();
  });
});
