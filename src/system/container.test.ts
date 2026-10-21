import { describe, expect, it } from "vitest";
import { createFakeFs } from "../__fixtures__/fake-seams.js";
import { type ContainerProbe, containerReasons, isInContainer, probeContainer } from "./container.js";

const NOTHING: ContainerProbe = {
  forced: false,
  ownMarker: false,
  hasDockerEnv: false,
  isSandbox: false,
  hasRemoteContainersEnv: false,
  hasPodmanEnv: false,
  hasContainerEnvVar: false,
  cgroupMentionsContainer: false
};

function probe(overrides: Partial<ContainerProbe>): ContainerProbe {
  return { ...NOTHING, ...overrides };
}

describe("isInContainer", () => {
  it.each<[keyof ContainerProbe, boolean]>([
    ["forced", true],
    ["ownMarker", true],
    ["hasDockerEnv", true],
    ["isSandbox", true],
    ["hasRemoteContainersEnv", true],
    ["hasPodmanEnv", true],
    ["hasContainerEnvVar", true],
    ["cgroupMentionsContainer", false]
  ])("should treat %s on its own as containerised: %s", (signal, expected) => {
    // Act
    const result = isInContainer(probe({ [signal]: true }));

    // Assert
    expect(result).toBe(expected);
  });

  it("should report nothing at all as not containerised", () => {
    // Act / Assert
    expect(isInContainer(NOTHING)).toBe(false);
  });

  it("should still detect a container when cgroup v2 reports a bare 0::/ alongside a real signal", () => {
    // Arrange — the false negative: /proc/1/cgroup gives away nothing under cgroup v2.
    const cgroupV2 = probe({ hasDockerEnv: true, cgroupMentionsContainer: false });

    // Act / Assert
    expect(isInContainer(cgroupV2)).toBe(true);
  });

  it("should let HAI_FORCE_CONTAINER override a probe that found nothing", () => {
    // Act / Assert
    expect(isInContainer(probe({ forced: true }))).toBe(true);
  });
});

describe("containerReasons", () => {
  it("should report only the forcing flag when it is set", () => {
    // Act
    const reasons = containerReasons(probe({ forced: true, hasDockerEnv: true }));

    // Assert
    expect(reasons).toEqual(["HAI_FORCE_CONTAINER=1"]);
  });

  it("should list every signal that fired", () => {
    // Act
    const reasons = containerReasons(probe({ hasDockerEnv: true, hasRemoteContainersEnv: true }));

    // Assert
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain("/.dockerenv");
    expect(reasons[1]).toContain("REMOTE_CONTAINERS");
  });

  it("should mark the cgroup signal as corroborating only", () => {
    // Act
    const reasons = containerReasons(probe({ hasDockerEnv: true, cgroupMentionsContainer: true }));

    // Assert
    expect(reasons[1]).toContain("corroborating only");
  });

  it("should list nothing when no signal fired", () => {
    // Act / Assert
    expect(containerReasons(NOTHING)).toEqual([]);
  });
});

describe("probeContainer", () => {
  it("should find nothing on a bare host", async () => {
    // Arrange
    const fs = createFakeFs({ "/proc/1/cgroup": "0::/\n" });

    // Act
    const result = await probeContainer({ env: {}, fs });

    // Assert
    expect(result).toEqual(NOTHING);
  });

  it("should read every file probe", async () => {
    // Arrange
    const fs = createFakeFs({
      "/.dockerenv": "",
      "/etc/cft-sandbox-env.sh": "export IS_SANDBOX=1",
      "/run/.containerenv": "",
      "/proc/1/cgroup": "0::/docker/abc123"
    });

    // Act
    const result = await probeContainer({ env: {}, fs });

    // Assert
    expect(result).toMatchObject({ hasDockerEnv: true, isSandbox: true, hasPodmanEnv: true, cgroupMentionsContainer: true });
  });

  it.each([
    ["IS_SANDBOX"],
    ["REMOTE_CONTAINERS"],
    ["REMOTE_CONTAINERS_IPC"],
    ["CODESPACES"],
    ["container"],
    ["HAI_IN_CONTAINER"],
    ["HAI_FORCE_CONTAINER"]
  ])("should read %s out of the environment", async (name) => {
    // Act
    const result = await probeContainer({ env: { [name]: "1" }, fs: createFakeFs() });

    // Assert
    expect(isInContainer(result)).toBe(true);
  });

  it("should ignore an empty REMOTE_CONTAINERS", async () => {
    // Act
    const result = await probeContainer({ env: { REMOTE_CONTAINERS: "" }, fs: createFakeFs() });

    // Assert
    expect(result.hasRemoteContainersEnv).toBe(false);
  });

  it.each([["containerd"], ["kubepods"]])("should notice %s in the cgroup", async (marker) => {
    // Act
    const result = await probeContainer({ env: {}, fs: createFakeFs({ "/proc/1/cgroup": `0::/${marker}/x` }) });

    // Assert
    expect(result.cgroupMentionsContainer).toBe(true);
  });
});
