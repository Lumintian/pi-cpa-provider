import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 25;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Hold `<path>.lock` while running `fn`.
 *
 * Uses the same mkdir lock directory as proper-lockfile, which Pi uses for
 * auth.json, so writes from this extension serialize with Pi's own writes.
 */
export function withFileLock<T>(path: string, fn: () => T): T {
	const lockPath = `${path}.lock`;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	while (true) {
		try {
			mkdirSync(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
					rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				continue;
			}
			if (Date.now() > deadline) throw new Error(`Timed out waiting for lock on ${path}`);
			sleepSync(LOCK_RETRY_MS);
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
}

export function readTextIfExists(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function parseJsonText(text: string, label: string): unknown {
	try {
		return JSON.parse(text.replace(/^﻿/, ""));
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Replace a file via temp file + rename so readers never see a partial write. */
export function writeFileAtomic(path: string, content: string, mode = 0o644): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(tmp, content, { encoding: "utf8", mode });
		renameSync(tmp, path);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			// Best effort cleanup; the original error matters.
		}
		throw error;
	}
}

export function removeFileIfExists(path: string): void {
	rmSync(path, { force: true });
}
