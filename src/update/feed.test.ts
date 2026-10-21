import { describe, expect, it } from "vitest";
import { FEED_URL, latestFromPackument, packumentUrl } from "./feed.js";

const FEED_NO_SLASH = FEED_URL.replace(/\/$/, "");

describe("packumentUrl", () => {
  it.each([
    ["a scoped package", FEED_URL, "@hmcts-cft/hai-cli", `${FEED_URL}@hmcts-cft%2Fhai-cli`],
    ["an unscoped package", FEED_URL, "hai-cli", `${FEED_URL}hai-cli`],
    ["a feed with no trailing slash", FEED_NO_SLASH, "@hmcts-cft/hai-cli", `${FEED_URL}@hmcts-cft%2Fhai-cli`]
  ])("should build the packument path for %s", (_name, feed, packageName, expected) => {
    // Act / Assert
    expect(packumentUrl(feed, packageName)).toBe(expected);
  });

  it("should encode the scope separator so the name stays one path segment", () => {
    // Act
    const url = packumentUrl(FEED_URL, "@hmcts-cft/hai-cli");

    // Assert
    expect(url).toContain("%2F");
    expect(url.endsWith("@hmcts-cft%2Fhai-cli")).toBe(true);
  });
});

describe("latestFromPackument", () => {
  it.each([
    ["the latest dist-tag", { "dist-tags": { latest: "1.2.3" } }, "1.2.3"],
    ["no dist-tags at all", { name: "@hmcts-cft/hai-cli" }, null],
    ["an empty latest", { "dist-tags": { latest: "" } }, null],
    ["a non-string latest", { "dist-tags": { latest: 3 } }, null],
    ["a body that is not an object", "nope", null],
    ["a null body", null, null]
  ])("should read %s", (_name, body, expected) => {
    // Act / Assert
    expect(latestFromPackument(body)).toBe(expected);
  });
});
