/*
 * Copyright (c) Mike Lischke. All rights reserved.
 * Licensed under the BSD 3-clause License. See License.txt in the project root for license information.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../../cli/Interpreter.ts", import.meta.url));

// The interpreter runs in the test folder, where the tsx loader cannot be found by name.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

interface IRunResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

/**
 * Runs the interpreter in a new folder with a few grammars and an input file. Tests run concurrently, so each run
 * gets its own folder.
 *
 * @param check Gets the result and the folder, before the folder is removed.
 * @param args The command line arguments.
 */
const run = (check: (result: IRunResult, dir: string) => void, ...args: string[]): void => {
    const dir = mkdtempSync(tmpdir() + "/AntlrInterpreterCli-");
    try {
        writeFileSync(dir + "/E.g4", "grammar E;\ns : ID+ EOF ;\nID : [a-z]+ ;\nWS : [ \\n]+ -> skip ;\n");
        writeFileSync(dir + "/EP.g4", "parser grammar EP;\noptions { tokenVocab = EL; }\ns : ID+ EOF ;\n");
        writeFileSync(dir + "/EL.g4", "lexer grammar EL;\nID : [a-z]+ ;\nWS : [ \\n]+ -> skip ;\n");
        writeFileSync(dir + "/Bad.g4", "grammar Bad;\ns : x ;\nID : [a-z]+ ;\n");
        writeFileSync(dir + "/input.txt", "ab cd\n");

        const result = spawnSync(process.execPath, ["--import", tsx, cli, ...args], { cwd: dir, encoding: "utf-8" });
        check(result, dir);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

/** The interpreter runs on import, so it is tested as a separate process. */
describe("Interpreter CLI", () => {
    it("parses with a combined grammar", () => {
        run((result, dir) => {
            expect(result.stderr).toBe("");
            expect(result.status).toBe(0);
            expect(result.stdout).toContain("[@0,0:1='ab',<ID>,1:0]");
            expect(result.stdout).toContain("(s:1 ab cd <EOF>)");

            // No profiling without --profile.
            expect(existsSync(dir + "/filename.csv")).toBe(false);
        }, "s", "input.txt", "E.g4", "--tokens", "--tree");
    }, 30000);

    it("parses with a parser grammar and its lexer grammar", () => {
        run((result) => {
            expect(result.status).toBe(0);
            expect(result.stdout).toContain("(s:1 ab cd <EOF>)");
        }, "s", "input.txt", "EP.g4", "EL.g4", "--tree");
    }, 30000);

    it("writes the profile to the given file", () => {
        run((result, dir) => {
            expect(result.status).toBe(0);

            const lines = readFileSync(dir + "/profile.csv", "utf-8").trim().split("\n");
            expect(lines[0]).toBe("Rule,Invocations,Time (ms),Total k,Max k,Ambiguities,DFA cache miss");
            expect(lines[1]).toMatch(/^s:0,2,/);

            // Prediction takes microseconds, not fractions of a picosecond (which a nanosecond conversion of the
            // millisecond value gave).
            const time = Number(lines[1].split(",")[2]);
            expect(time).toBeGreaterThan(1e-4);
            expect(time).toBeLessThan(10000);
        }, "s", "input.txt", "E.g4", "--profile", "profile.csv");
    }, 30000);

    it("reports grammar errors and fails", () => {
        run((result) => {
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("error(20): Bad.g4:2:4: reference to undefined rule: x");
            expect(result.stderr).not.toContain("The ATN must be created");
        }, "s", "input.txt", "Bad.g4");
    }, 30000);

    it("fails for an unknown start rule", () => {
        run((result) => {
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("No such start rule: nosuch");
        }, "nosuch", "input.txt", "E.g4");
    }, 30000);

    it("fails for grammars in the wrong order or number", () => {
        run((result) => {
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("EP.g4 is not a lexer grammar");
        }, "s", "input.txt", "EL.g4", "EP.g4");

        run((result) => {
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("EP.g4 is not a combined grammar");
        }, "s", "input.txt", "EP.g4");

        run((result) => {
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("Expected an input file");
        }, "s", "input.txt", "EP.g4", "EL.g4", "E.g4");
    }, 60000);
});
