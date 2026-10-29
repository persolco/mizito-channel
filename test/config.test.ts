import { expect, test } from "bun:test";
import { loadConfig } from "../src/core/config";

test("defaults", () => {
  const c = loadConfig({});
  expect(c.baseUrl).toBe("https://app.mizito.ir");
  expect(c.allowSend).toBe(false);
  expect(c.allowDownload).toBe(false);
  expect(c.allowTaskWrite).toBe(false);
  expect(c.userId).toBeUndefined();
  expect(c.pollIntervalMs).toBe(10_000);
  expect(c.home.endsWith("/mizito")).toBe(true);
});

test("task write gate is independent and only 1 enables it", () => {
  expect(loadConfig({ MIZITO_ALLOW_TASK_WRITE: "1" }).allowTaskWrite).toBe(true);
  expect(loadConfig({ MIZITO_ALLOW_TASK_WRITE: "true", MIZITO_ALLOW_SEND: "1" }).allowTaskWrite).toBe(false);
});

test("MIZITO_HOME overrides the config directory", () => {
  expect(loadConfig({ MIZITO_HOME: "/tmp/x" }).home).toBe("/tmp/x");
});

test("download gate is independent and only 1 enables it", () => {
  expect(loadConfig({ MIZITO_ALLOW_DOWNLOAD: "1" }).allowDownload).toBe(true);
  expect(loadConfig({ MIZITO_ALLOW_DOWNLOAD: "true", MIZITO_ALLOW_SEND: "1" }).allowDownload).toBe(false);
});

test("only MIZITO_ALLOW_SEND=1 enables sending", () => {
  expect(loadConfig({ MIZITO_ALLOW_SEND: "1" }).allowSend).toBe(true);
  expect(loadConfig({ MIZITO_ALLOW_SEND: "true" }).allowSend).toBe(false);
  expect(loadConfig({ MIZITO_ALLOW_SEND: "0" }).allowSend).toBe(false);
});

test("poll interval ignores junk values", () => {
  expect(loadConfig({ MIZITO_POLL_MS: "2500" }).pollIntervalMs).toBe(2500);
  expect(loadConfig({ MIZITO_POLL_MS: "abc" }).pollIntervalMs).toBe(10_000);
  expect(loadConfig({ MIZITO_POLL_MS: "-5" }).pollIntervalMs).toBe(10_000);
});

test("MIZITO_PUSH_CHATS is a trimmed comma-separated list", () => {
  expect(loadConfig({}).pushChats).toEqual([]);
  expect(loadConfig({ MIZITO_PUSH_CHATS: " Team , 69aa ,," }).pushChats).toEqual(["Team", "69aa"]);
});

test("a poll interval below one second is raised to one second", () => {
  expect(loadConfig({ MIZITO_POLL_MS: "50" }).pollIntervalMs).toBe(1000);
});
