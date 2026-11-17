/**
 * The injection corpus (plan §3.11): elements strict validation must refuse,
 * each with the field path it must name. Used by the unit tests and by the
 * server's integration tests (over /ops and /import). Not part of the app bundle.
 */
import { createEmbed, createFrame, createImage, createShape, createText } from "../scene/elements";
import { LIMITS } from "./limits";

export const injectionCorpus = (): [Record<string, unknown>, string][] => {
  const base = createShape("rectangle", 10, 20) as unknown as Record<string, unknown>;
  const missingSeed = { ...base };
  delete missingSeed.seed;
  return [
    [{ ...base, strokeColor: '#000" onload="alert(1)' }, "strokeColor"],
    [{ ...base, strokeColor: "red" }, "strokeColor"],
    [{ ...base, strokeColor: "#ABCDEF" }, "strokeColor"],
    [{ ...base, backgroundColor: "url(javascript:alert(1))" }, "backgroundColor"],
    [{ ...base, id: "<script>" }, "id"],
    [{ ...base, id: "x".repeat(65) }, "id"],
    [{ ...base, x: Number.NaN }, "x"],
    [{ ...base, width: Infinity }, "width"],
    [{ ...base, width: -1 }, "width"],
    [{ ...base, angle: 100 }, "angle"],
    [{ ...base, opacity: 101 }, "opacity"],
    [{ ...base, fillStyle: "plaid" }, "fillStyle"],
    [{ ...base, link: "javascript:alert(1)" }, "link"],
    [{ ...base, link: "example.com" }, "link"],
    [{ ...base, groupIds: ["ok", "<b>"] }, "groupIds[1]"],
    [{ ...base, onclick: "alert(1)" }, "onclick"],
    [{ ...base, __proto__x: 1 }, "__proto__x"],
    [{ ...base, type: "script" }, "type"],
    [{ ...createText(0, 0), text: "a".repeat(LIMITS.textChars + 1) }, "text"],
    [{ ...createFrame(0, 0), name: "n".repeat(LIMITS.frameName + 1) }, "name"],
    [{ ...createEmbed(0, 0, "https://youtu.be/x"), url: "javascript:alert(1)" }, "url"],
    [{ ...createImage(0, 0, 10, 10, "f1"), fileId: "../etc" }, "fileId"],
    [missingSeed, "seed"],
  ];
};
