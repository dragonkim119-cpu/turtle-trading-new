import { describe, expect, it, vi } from "vitest";
import { openDb, Repo } from "@turtle/db";
import { parseFredDaily, pollMacro } from "../src/macro.js";

describe("parseFredDaily", () => {
  it("extracts the most recent numeric row", () => {
    const csv = "observation_date,VIXCLS\n2026-07-15,15.67\n2026-07-16,16.73";
    expect(parseFredDaily(csv)).toEqual({ date: "2026-07-16", value: 16.73 });
  });
  it("skips FRED missing-value rows ('.')", () => {
    const csv = "observation_date,DGS10\n2026-07-15,4.55\n2026-07-16,.";
    expect(parseFredDaily(csv)).toEqual({ date: "2026-07-15", value: 4.55 });
  });
  it("returns null on malformed csv", () => {
    expect(parseFredDaily("garbage")).toBeNull();
    expect(parseFredDaily("")).toBeNull();
  });
});

describe("pollMacro", () => {
  it("stores latest value per macro symbol and isolates per-source failure", async () => {
    const repo = new Repo(openDb(":memory:"));
    const fetchCsv = vi.fn(async (url: string) => {
      if (url.includes("VIXCLS")) throw new Error("feed down"); // one source fails
      return "observation_date,X\n2026-07-17,3.14";
    });
    await pollMacro({ repo, fetchCsv });
    // DXY + US10Y stored, VIX failed but didn't abort the rest
    expect(repo.getMacroSeries("DXY").at(-1)?.value).toBeCloseTo(3.14);
    expect(repo.getMacroSeries("US10Y").at(-1)?.value).toBeCloseTo(3.14);
    expect(repo.getMacroSeries("VIX")).toHaveLength(0);
  });
});
