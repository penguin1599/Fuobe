/**
 * The class names of Home's first screen (home-bento.css), each with its hb- prefix. The sheet is global, as every
 * stylesheet in this app is (next.config.ts runs each .css file through Tailwind as plain CSS), so the prefix keeps its
 * names to itself.
 */
const NAMES = ["accent","aside","audio","badge","bento","big","board","box","canvas","caret","clip","copy","corner","cta","edges","end","figures","fill","filmMark","foot","frame","genjutsu","grid","h1","head","image","kenburns","l2b","line1","line2","live","meta","node","nodeLabel","numbers","numbersFoot","numbersLine","out","pic","pill","progress","shade","step","three","tile","title","tsx","typed","video","voice","voiceBar","voiceChip","voiceCopy","voiceDot","voiceGo","voiceLink","voiceNear","voicePics","voicePlay","voiceQuiet","voiceSwitch","voiceUi","wipe","wipeAfter","wipeBefore"] as const;

export const s = Object.fromEntries(NAMES.map((n) => [n, `hb-${n.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`])) as Record<(typeof NAMES)[number], string>;
