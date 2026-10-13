import "./fonts.css";

// Faces load when text first uses them, which would hold back a menu's first
// showing; load them all once the page has.
addEventListener("load", () => document.fonts.forEach((face) => void face.load()));
