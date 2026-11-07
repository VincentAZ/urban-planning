# Report fonts

`DejaVuSans.ttf` and `DejaVuSans-Bold.ttf` are unmodified DejaVu Sans fonts copied from the installed `fonts-dejavu-core` distribution. The retained copyright and permission notices are in `LICENSE-DejaVu.txt`; its Debian packaging section concerns packaging files, which are not bundled here.

Official project and license: https://dejavu-fonts.github.io/ and https://dejavu-fonts.github.io/License.html . Keep the license with these assets. Report maps load these explicit files with system-font discovery disabled, so another host's font collection cannot silently change the images. PDF exports can use the same Unicode fonts.
