import { describe, expect, it } from "vitest";
import { createFakeSeams, FIXED_NOW, type RunResponder } from "../__fixtures__/fake-seams.js";
import {
  acrLogin,
  acrPullToken,
  CACHE_FILE,
  dockerConfigJson,
  hasAzSession,
  isAcrImage,
  LOGIN_TTL_MS,
  needsAcrLogin,
  pullImage,
  REGISTRY_HOST,
  shouldPull,
  TOKEN_USER
} from "./acr.js";
import { DEFAULT_IMAGE } from "./docker-args.js";

const HOME = "/home/linus";
const STATE = `${HOME}/.local/state/hai/${CACHE_FILE}`;
const TOKEN = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.fake-acr-token.sig";

describe("needsAcrLogin", () => {
  it.each<[string, { lastAt: number | null; now: number; retry: boolean }, boolean]>([
    ["nothing is on record", { lastAt: null, now: FIXED_NOW, retry: false }, true],
    ["the login is fresh", { lastAt: FIXED_NOW - 60_000, now: FIXED_NOW, retry: false }, false],
    ["the login is just inside the window", { lastAt: FIXED_NOW - (LOGIN_TTL_MS - 1), now: FIXED_NOW, retry: false }, false],
    ["the login is exactly at the window", { lastAt: FIXED_NOW - LOGIN_TTL_MS, now: FIXED_NOW, retry: false }, true],
    ["the login is older than the window", { lastAt: FIXED_NOW - 4 * 60 * 60 * 1000, now: FIXED_NOW, retry: false }, true],
    ["this is the retry after an unauthorized", { lastAt: FIXED_NOW, now: FIXED_NOW, retry: true }, true]
  ])("should decide when %s", (_name, input, expected) => {
    // Act / Assert
    expect(needsAcrLogin(input).yes).toBe(expected);
  });

  it("should say how old the login is", () => {
    // Act / Assert
    expect(needsAcrLogin({ lastAt: FIXED_NOW - 3 * 60 * 60 * 1000, now: FIXED_NOW, retry: false }).reason).toContain("180 minutes old");
  });
});

describe("shouldPull", () => {
  it.each<[string, { policy: string | undefined; present: boolean }, boolean]>([
    ["the default and no image yet", { policy: undefined, present: false }, true],
    ["the default and the image already here", { policy: undefined, present: true }, true],
    ["HAI_PULL=always with no image", { policy: "always", present: false }, true],
    ["HAI_PULL=always with the image already here", { policy: "always", present: true }, true],
    ["HAI_PULL=missing with no image", { policy: "missing", present: false }, true],
    ["HAI_PULL=missing with the image already here", { policy: "missing", present: true }, false],
    ["HAI_PULL=never with no image", { policy: "never", present: false }, false],
    ["HAI_PULL=never with the image already here", { policy: "never", present: true }, false]
  ])("should decide with %s", (_name, input, expected) => {
    // Act / Assert
    expect(shouldPull(input).yes).toBe(expected);
  });

  it("should refuse a policy that is not one of the three", () => {
    // Act / Assert
    expect(() => shouldPull({ policy: "sometimes", present: true })).toThrow("HAI_PULL=sometimes");
  });
});

describe("dockerConfigJson", () => {
  it("should hold only the one registry, under the null-GUID user ACR issues the token for", () => {
    // Act
    const config = JSON.parse(dockerConfigJson(TOKEN)) as { auths: Record<string, { auth: string }> };

    // Assert
    expect(Object.keys(config.auths)).toEqual([REGISTRY_HOST]);
    expect(Buffer.from(config.auths[REGISTRY_HOST]!.auth, "base64").toString("utf8")).toBe(`${TOKEN_USER}:${TOKEN}`);
  });
});

describe("isAcrImage", () => {
  it.each<[string, boolean]>([
    [DEFAULT_IMAGE, true],
    ["hai-devcontainer:dind", false],
    ["ghcr.io/other/image:tag", false]
  ])("should classify %s", (image, expected) => {
    // Act / Assert
    expect(isAcrImage(image)).toBe(expected);
  });
});

describe("hasAzSession", () => {
  it.each<[string, number, boolean]>([
    ["a token can still be minted", 0, true],
    ["the refresh token has expired", 1, false]
  ])("should report %s", async (_name, code, expected) => {
    // Arrange
    const seams = createFakeSeams({ respond: () => ({ code }) });

    // Act / Assert
    expect(await hasAzSession(seams)).toBe(expected);
    expect(seams.runner.calls[0]?.argv).toContain("get-access-token");
  });
});

describe("acrPullToken", () => {
  it("should mint a token", async () => {
    // Arrange
    const seams = createFakeSeams({ respond: (argv) => ({ code: 0, stdout: argv[1] === "acr" ? `${TOKEN}\n` : "" }) });

    // Act / Assert
    expect(await acrPullToken(seams)).toBe(TOKEN);
  });

  it.each<[string, RunResponder]>([
    ["there is no az session", () => ({ code: 1 })],
    ["az acr login fails", (argv) => ({ code: argv[1] === "acr" ? 1 : 0 })],
    ["az acr login answers nothing", (argv) => ({ code: 0, stdout: argv[1] === "acr" ? "\n" : "" })]
  ])("should return null when %s", async (_name, respond) => {
    // Arrange
    const seams = createFakeSeams({ respond });

    // Act / Assert
    expect(await acrPullToken(seams)).toBeNull();
  });
});

describe("acrLogin", () => {
  it("should pass the token on stdin and record when it did", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: () => ({ code: 0 }) });

    // Act
    const ok = await acrLogin(seams, TOKEN);

    // Assert
    expect(ok).toBe(true);
    expect(seams.runner.calls[0]?.argv).toEqual(["docker", "login", REGISTRY_HOST, "-u", TOKEN_USER, "--password-stdin"]);
    expect(seams.runner.calls[0]?.opts.stdin).toBe(TOKEN);
    expect(JSON.parse(seams.fs.store.get(STATE)!)).toEqual({ loginAt: FIXED_NOW });
  });

  it("should never put the token in argv", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: () => ({ code: 0 }) });

    // Act
    await acrLogin(seams, TOKEN);

    // Assert
    expect(seams.runner.calls[0]?.argv.join(" ")).not.toContain(TOKEN);
  });

  it("should report a failed login rather than throw", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME, HAI_VERBOSE: "1" }, respond: () => ({ code: 1, stderr: "denied" }) });

    // Act / Assert
    expect(await acrLogin(seams, TOKEN)).toBe(false);
    expect(seams.lines.join("")).toContain("docker login");
  });

  it("should carry on when the state directory cannot be written", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HAI_VERBOSE: "1" }, respond: () => ({ code: 0 }) });

    // Act / Assert
    expect(await acrLogin(seams, TOKEN)).toBe(true);
    expect(seams.lines.join("")).toContain("could not record");
  });
});

describe("pullImage", () => {
  const image = DEFAULT_IMAGE;

  it("should log in and pull when nothing is on record", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME, HAI_VERBOSE: "1" },
      respond: (argv) => {
        if (argv[1] === "image") {
          return { code: 1 };
        }
        return { code: 0, stdout: argv[1] === "acr" ? TOKEN : "" };
      }
    });

    // Act
    await pullImage(seams, { image, policy: undefined });

    // Assert
    expect(seams.runner.calls.map((call) => `${call.argv[0]} ${call.argv[1]}`)).toEqual([
      "docker image",
      "az account",
      "az acr",
      "docker login",
      "docker pull"
    ]);
    expect(JSON.parse(seams.fs.store.get(STATE)!).loginAt).toBe(FIXED_NOW);
  });

  it("should reuse a login that is still good", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME },
      files: { [STATE]: JSON.stringify({ loginAt: FIXED_NOW - 60_000 }) },
      respond: (argv) => ({ code: argv[1] === "image" ? 1 : 0 })
    });

    // Act
    await pullImage(seams, { image, policy: undefined });

    // Assert
    expect(seams.runner.calls.map((call) => call.argv[1])).toEqual(["image", "pull"]);
  });

  it("should stream the pull and still read an unauthorized out of the captured stderr, refreshing the token and retrying once", async () => {
    // Arrange
    let pulls = 0;
    const seams = createFakeSeams({
      env: { HOME },
      files: { [STATE]: JSON.stringify({ loginAt: FIXED_NOW - 60_000 }) },
      respond: (argv) => {
        if (argv[1] === "image") {
          return { code: 1 };
        }
        if (argv[1] === "pull") {
          pulls += 1;
          return pulls === 1 ? { code: 1, stderr: "unauthorized: authentication required" } : { code: 0 };
        }
        return { code: 0, stdout: argv[1] === "acr" ? TOKEN : "" };
      }
    });

    // Act
    await pullImage(seams, { image, policy: undefined });

    // Assert
    expect(pulls).toBe(2);
    expect(seams.runner.calls.filter((call) => call.argv[1] === "login")).toHaveLength(1);
    expect(seams.runner.calls.filter((call) => call.argv[1] === "pull").map((call) => call.opts.echo)).toEqual([true, true]);
  });

  it("should say what it is pulling without being asked to be verbose, and say it once", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: (argv) => ({ code: argv[1] === "image" ? 1 : 0, stdout: argv[1] === "acr" ? TOKEN : "" }) });

    // Act
    await pullImage(seams, { image, policy: undefined });

    // Assert
    expect(seams.lines).toEqual([`hai: pulling ${image}: no HAI_PULL set, so the default is always\n`]);
  });

  it("should leave a decision not to pull verbose-only, so a HAI_PULL=never launch says nothing", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: () => ({ code: 0 }) });

    // Act
    await pullImage(seams, { image, policy: "never" });

    // Assert
    expect(seams.lines).toEqual([]);
  });

  it("should not retry twice", async () => {
    // Arrange
    let pulls = 0;
    const seams = createFakeSeams({
      env: { HOME },
      respond: (argv) => {
        if (argv[1] === "image") {
          return { code: 0 };
        }
        if (argv[1] === "pull") {
          pulls += 1;
          return { code: 1, stderr: "unauthorized" };
        }
        return { code: 0, stdout: argv[1] === "acr" ? TOKEN : "" };
      }
    });

    // Act
    await pullImage(seams, { image, policy: "always" });

    // Assert
    expect(pulls).toBe(2);
  });

  it("should treat an unreachable state directory as nothing on record", async () => {
    // Arrange
    const seams = createFakeSeams({ respond: (argv) => ({ code: argv[1] === "image" ? 1 : 0, stdout: argv[1] === "acr" ? TOKEN : "" }) });

    // Act
    await pullImage(seams, { image, policy: undefined });

    // Assert
    expect(seams.runner.calls.map((call) => call.argv[1])).toContain("login");
  });

  it("should carry on with the cached image when an always-pull fails", async () => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME, HAI_VERBOSE: "1" },
      respond: (argv) => (argv[1] === "image" ? { code: 0 } : { code: 1, stderr: "dial tcp: lookup hmctsprod.azurecr.io: no such host" })
    });

    // Act
    await expect(pullImage(seams, { image, policy: "always" })).resolves.toBeUndefined();

    // Assert
    expect(seams.lines.join("")).toContain(`could not pull ${image}`);
  });

  it("should fail when the pull fails and the image is not here either", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: (argv) => ({ code: argv[1] === "account" ? 1 : 1, stderr: "no such host" }) });

    // Act / Assert
    await expect(pullImage(seams, { image, policy: undefined })).rejects.toThrow("could not pull");
  });

  it("should skip the registry login for an image that is not on the registry", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: (argv) => ({ code: argv[1] === "image" ? 1 : 0 }) });

    // Act
    await pullImage(seams, { image: "hai-devcontainer:dind", policy: undefined });

    // Assert
    expect(seams.runner.calls.map((call) => call.argv[1])).toEqual(["image", "pull"]);
  });

  it("should not pull at all under HAI_PULL=never", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME }, respond: () => ({ code: 0 }) });

    // Act
    await pullImage(seams, { image, policy: "never" });

    // Assert
    expect(seams.runner.calls.map((call) => call.argv[1])).toEqual(["image"]);
  });

  it.each<[string, string]>([
    ["a cache that is not JSON", "{"],
    ["a cache with nonsense in it", '{"loginAt":"soon"}']
  ])("should treat %s as nothing on record", async (_name, contents) => {
    // Arrange
    const seams = createFakeSeams({
      env: { HOME },
      files: { [STATE]: contents },
      respond: (argv) => ({ code: argv[1] === "image" ? 1 : 0, stdout: argv[1] === "acr" ? TOKEN : "" })
    });

    // Act
    await pullImage(seams, { image, policy: undefined });

    // Assert
    expect(seams.runner.calls.map((call) => call.argv[1])).toContain("login");
  });
});
