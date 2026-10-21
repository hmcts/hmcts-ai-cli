import { describe, expect, it } from "vitest";
import { dockerVolumeName, historyVolumeName, projectSlug, sessionName } from "./session.js";

describe("projectSlug", () => {
  it.each<[string, string]>([
    ["/home/linus/Work/solirius/hmcts", "-home-linus-Work-solirius-hmcts"],
    ["/home/dev/pcs-api", "-home-dev-pcs-api"],
    ["/", "-"]
  ])("should slug %s the way Claude Code does", (path, expected) => {
    // Act / Assert
    expect(projectSlug(path)).toBe(expected);
  });
});

describe("sessionName", () => {
  it("should name the session after the repo directory and a digest of its path", () => {
    // Act
    const name = sessionName({ repoPath: "/home/linus/Work/solirius/hmcts" });

    // Assert
    expect(name).toMatch(/^hai-hmcts-[0-9a-f]{8}$/);
  });

  it("should be stable for the same path and different for another", () => {
    // Act
    const same = sessionName({ repoPath: "/a/hmcts" });
    const other = sessionName({ repoPath: "/b/hmcts" });

    // Assert
    expect(sessionName({ repoPath: "/a/hmcts" })).toBe(same);
    expect(other).not.toBe(same);
  });

  it.each<[string, string, string]>([
    ["an upper-case directory", "/home/dev/PCS-Api", "hai-pcs-api-"],
    ["spaces and punctuation", "/home/dev/My Repo (wip)", "hai-my-repo-wip-"],
    ["a leading dot", "/home/dev/.hidden", "hai-hidden-"],
    ["the filesystem root", "/", "hai-repo-"]
  ])("should make a usable Docker name from %s", (_name, repoPath, prefix) => {
    // Act / Assert
    expect(sessionName({ repoPath })).toMatch(new RegExp(`^${prefix}[0-9a-f]{8}$`));
  });

  it.each<[string, string | undefined]>([
    ["a name", "my-session"],
    ["an empty string, which reads as unset", ""]
  ])("should honour HAI_SESSION given %s", (_name, requested) => {
    // Act
    const name = sessionName({ repoPath: "/home/dev/pcs-api", requested });

    // Assert
    expect(name).toBe(requested === "" ? "hai-pcs-api-fd1b5f77" : requested);
  });
});

describe("the session's volumes", () => {
  it("should derive both names from the session, so two repos never share a nested engine", () => {
    // Act / Assert
    expect(dockerVolumeName("hai-hmcts-abcd1234")).toBe("hai-hmcts-abcd1234-docker");
    expect(historyVolumeName("hai-hmcts-abcd1234")).toBe("hai-hmcts-abcd1234-projects");
  });
});
