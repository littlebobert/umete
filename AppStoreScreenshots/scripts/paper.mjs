// What the still pages (render.mjs) and the search result video (search.mjs) share:
// the headline typefaces and the faint form-field paper.

export function fontFamily(locale) {
  return locale === "ja"
    ? `"Hiragino Mincho ProN", "Yu Mincho", serif`
    : `"New York", "Iowan Old Style", Georgia, serif`;
}

// Faint empty form fields, a label over a rounded box, two to a row: the paper the
// header and the search card share, as Kaketa's share squared paper.
export function fieldsCSS(height) {
  const row = height / 5;
  const width = row * 3.4;
  const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${row}">
    <rect x="${row * 0.2}" y="${row * 0.18}" width="${row * 0.9}" height="${row * 0.07}" rx="${row * 0.035}" fill="#e3dccd"/>
    <rect x="${row * 0.2}" y="${row * 0.36}" width="${width - row * 0.4}" height="${row * 0.44}" rx="${row * 0.09}" fill="#f9f6f0" stroke="#e3dccd" stroke-width="${row * 0.018}"/>
  </svg>`;
  return `position: absolute; inset: 0; opacity: 0.9; background-image: url("data:image/svg+xml,${encodeURIComponent(tile)}"); background-size: ${width}px ${row}px; background-position: ${(width * 0.37) % width}px ${row * 0.5}px;`;
}
