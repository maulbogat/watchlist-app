import { describe, expect, it } from "vitest";
import { getCurrentListLabel, getCurrentListValue } from "./lists.js";
import type { ListMode, PersonalList, SharedList } from "../types/index.js";

describe("getCurrentListValue", () => {
  it("returns personal when listMode is personal", () => {
    expect(getCurrentListValue("personal", [])).toBe("personal");
  });

  it("returns listId for personal list object mode", () => {
    const mode: ListMode = { type: "personal", listId: "p1", name: "My list" };
    expect(getCurrentListValue(mode, [])).toBe("p1");
  });

  it("returns listId for shared list object mode", () => {
    const mode: ListMode = { type: "shared", listId: "s1", name: "Our list" };
    expect(getCurrentListValue(mode, [])).toBe("s1");
  });
});

describe("getCurrentListLabel", () => {
  const personalLists: PersonalList[] = [
    { id: "personal", name: "Main personal", count: 10, isDefault: true },
    { id: "p1", name: "Secondary", count: 2, isDefault: false },
    { id: "empty-name", name: "", count: 0, isDefault: false },
  ];
  const sharedLists: SharedList[] = [{ id: "s1", name: "Team list", items: [] }];

  it("returns personal list label for personal mode when found", () => {
    expect(getCurrentListLabel("personal", personalLists, sharedLists)).toBe("Main personal");
  });

  it("returns fallback when personal list is not found", () => {
    expect(getCurrentListLabel("personal", [], sharedLists)).toBe("Set name…");
  });

  it("returns shared mode name for shared mode", () => {
    const mode: ListMode = { type: "shared", listId: "s1", name: "Shared Focus" };
    expect(getCurrentListLabel(mode, personalLists, sharedLists)).toBe("Shared Focus");
  });

  it("returns displayListName fallback for empty names", () => {
    const mode: ListMode = { type: "shared", listId: "s2", name: "" };
    expect(getCurrentListLabel(mode, personalLists, sharedLists)).toBe("Set name…");
  });

  it("returns personal object mode name from list or mode fallback", () => {
    const foundMode: ListMode = { type: "personal", listId: "p1", name: "Ignored fallback" };
    const missingMode: ListMode = { type: "personal", listId: "missing", name: "Fallback Name" };
    expect(getCurrentListLabel(foundMode, personalLists, sharedLists)).toBe("Secondary");
    expect(getCurrentListLabel(missingMode, personalLists, sharedLists)).toBe("Fallback Name");
  });
});
