import { describe, expect, it } from "vitest";
import { stateDir, statePath, tryStateDir, tryStatePath } from "./state-dir.js";

describe("stateDir", () => {
  it("should default to ~/.local/state/hai", () => {
    // Act / Assert
    expect(stateDir({ HOME: "/home/dev" })).toBe("/home/dev/.local/state/hai");
  });

  it("should prefer XDG_STATE_HOME", () => {
    // Act / Assert
    expect(stateDir({ HOME: "/home/dev", XDG_STATE_HOME: "/run/user/1000" })).toBe("/run/user/1000/hai");
  });

  it("should treat an empty XDG_STATE_HOME as unset", () => {
    // Act / Assert
    expect(stateDir({ HOME: "/home/dev", XDG_STATE_HOME: "" })).toBe("/home/dev/.local/state/hai");
  });

  it.each([
    ["no HOME", {}],
    ["an empty HOME", { HOME: "" }]
  ])("should throw with %s, because a caller that needs the directory cannot go on", (_name, env) => {
    // Act / Assert
    expect(() => stateDir(env)).toThrow("nowhere to keep hai's state");
  });
});

describe("tryStateDir", () => {
  it("should answer null rather than throw when there is nowhere to write", () => {
    // Act / Assert
    expect(tryStateDir({})).toBeNull();
  });
});

describe("statePath", () => {
  it("should join a file name onto the state directory", () => {
    // Act / Assert
    expect(statePath({ HOME: "/home/dev" }, "auth.json")).toBe("/home/dev/.local/state/hai/auth.json");
  });
});

describe("tryStatePath", () => {
  it("should join a file name onto the state directory", () => {
    // Act / Assert
    expect(tryStatePath({ HOME: "/home/dev" }, "auth.json")).toBe("/home/dev/.local/state/hai/auth.json");
  });

  it("should answer null when there is nowhere to write", () => {
    // Act / Assert
    expect(tryStatePath({}, "auth.json")).toBeNull();
  });
});
