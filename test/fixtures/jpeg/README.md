# JPEG fixtures

Small JPEG files (173 × 97 pixels, coloured blurred shapes) written with
Pillow, so `src/jpeg-scaled.js` is checked against files from another encoder
than the one it uses: 4:2:0 sampling with restart markers every 2 MCUs, 4:2:2,
4:4:4, greyscale, and a progressive file (refused by the small decoder, read by
jpeg-js).
