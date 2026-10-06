# Starcatcher Stage Manager PWA

Version 0.2.0

## Source hierarchy
1. `PETER & THE STARCATCHER PRESETS.docx` — authoritative physical Act I / Act II preset and intermission setup.
2. `PETER & THE STARCATCHER PROPS.docx` — authoritative backstage SR/SL prop inventory and quantities.
3. `STARCATCHER PROPS(2).xlsx` — prop movement / responsibility run track.
4. Supplied Act I / Act II photos — visual verification of the written preset, not a replacement for it.

## Included
- iPad-friendly Act I preset checklist, grouped by exact physical area
- Act I backstage SR/SL prop inventory with quantities
- Intermission / Act II changeover checklist
- Act II preset and backstage additions
- All supplied preset reference photos, linked to relevant sections where practical
- Run Track from the original prop tracking workbook
- Edit presets, movements, and prop master
- IndexedDB local storage
- JSON export, merge import, and replace import
- Offline PWA service worker
- Automatic v0.1 → v0.2 starter-data migration while preserving custom props/movements

## iPad use
Publish the folder to any HTTPS static host (GitHub Pages works), open it once in Safari, then Share > Add to Home Screen. After the first successful load the PWA works offline.

## Sharing edits without a server
Edit Show > Backup / Import > Export data. Send the JSON file to the other device. Use Import + merge for normal collaboration or Import + replace when that file should become the new master.

## Updating bundled photos
Replace the image in `images/act1/` or `images/act2/` and publish a new app version. The data export does not contain bundled photos.
