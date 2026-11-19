// Chromium's expected output (.out) lists one field per line, in DOM order:
//   TYPE | name or id | label | initial value | form signature
// Blank lines separate forms.

function parseExpected(text) {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.includes("|")) return [];
    const [type, name = "", label = "", value = ""] = line.split("|").map((part) => part.trim());
    return [{ type, name, label, value }];
  });
}

const UNFILLABLE = new Set(["hidden", "submit", "button", "image", "reset", "file"]);

// Pairs each expected row with a control, walking both in DOM order so
// repeated names (billing and shipping "firstName") line up. A row with no
// name takes the next unused nameless control, when that can be trusted.
function mapRows(rows, controls) {
  const fillable = controls.filter((control) => !UNFILLABLE.has(control.type));
  // Rows without a name can only be lined up by position, which is safe only
  // when the page has exactly as many nameless text fields and dropdowns.
  const namelessRows = rows.filter((row) => !row.name).length;
  const namelessControls = fillable.filter((control) => !control.name && !control.id && control.type !== "checkbox" && control.type !== "radio").length;
  const positional = namelessRows === namelessControls;
  const used = new Set();
  let cursor = 0;
  const fits = (row) => (control) => !used.has(control.index) && (row.name
    ? control.name === row.name || control.id === row.name
    : positional && !control.name && !control.id && control.type !== "checkbox" && control.type !== "radio");
  return rows.map((row) => {
    const fit = fits(row);
    let position = fillable.findIndex((control, index) => index >= cursor && fit(control));
    if (position < 0 && row.name) position = fillable.findIndex(fit);
    const control = position >= 0 ? fillable[position] : null;
    if (control) {
      used.add(control.index);
      cursor = Math.max(cursor, position + 1);
    }
    return { row, control };
  });
}

module.exports = { parseExpected, mapRows };
