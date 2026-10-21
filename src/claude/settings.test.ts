import { describe, expect, it } from "vitest";
import { createFakeSeams } from "../__fixtures__/fake-seams.js";
import { STATE_DIR_MODE, STATE_FILE_MODE } from "../system/state-dir.js";
import { buildSettings, materialiseSettings, SETTINGS_FILE } from "./settings.js";

const HOME = "/home/dev";
const SETTINGS_PATH = `${HOME}/.local/state/hai/${SETTINGS_FILE}`;
const HELPER = `${HOME}/.local/state/hai/gateway-token.sh`;

describe("buildSettings", () => {
  it("should ask for cross-session inbound inside a workspace, as run.sh does", () => {
    // Act / Assert
    expect(buildSettings({ inWorkspace: true })).toEqual({ crossSessionInbound: "accept" });
  });

  it("should point at the api key helper on the gateway route", () => {
    // Act / Assert
    expect(buildSettings({ inWorkspace: false, apiKeyHelperPath: HELPER })).toEqual({ apiKeyHelper: HELPER });
  });

  it("should carry both when a gateway session runs inside a workspace", () => {
    // Act / Assert
    expect(buildSettings({ inWorkspace: true, apiKeyHelperPath: HELPER })).toEqual({ crossSessionInbound: "accept", apiKeyHelper: HELPER });
  });

  it("should be empty outside a workspace with no helper", () => {
    // Act / Assert
    expect(buildSettings({ inWorkspace: false })).toEqual({});
  });
});

describe("materialiseSettings", () => {
  it("should pass empty settings through as no --settings at all", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });

    // Act / Assert
    expect(await materialiseSettings(seams, {}, false)).toBeUndefined();
  });

  it("should inline settings as json when there is no file to write", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });

    // Act
    const value = await materialiseSettings(seams, { crossSessionInbound: "accept" }, false);

    // Assert
    expect(value).toBe('{"crossSessionInbound":"accept"}');
    expect(seams.fs.store.size).toBe(0);
  });

  it("should write a 0600 file in the 0700 state directory when asked", async () => {
    // Arrange
    const seams = createFakeSeams({ env: { HOME } });

    // Act
    const value = await materialiseSettings(seams, { apiKeyHelper: HELPER }, true);

    // Assert
    expect(value).toBe(SETTINGS_PATH);
    expect(seams.fs.store.get(SETTINGS_PATH)).toBe(`{"apiKeyHelper":"${HELPER}"}\n`);
    expect(seams.fs.modes.get(SETTINGS_PATH)).toBe(STATE_FILE_MODE);
    expect(seams.fs.modes.get(`${HOME}/.local/state/hai`)).toBe(STATE_DIR_MODE);
  });
});
