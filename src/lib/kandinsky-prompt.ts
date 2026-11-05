/**
 * Kandinsky 6.0 (oss-kandinsky6 on your GPU, kandinsky-6 on fal): the prompt the model reads. Kandinsky's captions mark
 * the words a character says as <S>…<E>, at the moment they are said, and the sound of the shot as <AUDCAP>…<ENDAUDCAP>
 * after the picture (the Kandinsky 6 README and its prompt helper's examples). People write neither: words in quotes are
 * what is said, and a line or sentence starting "Sound:" (or "Audio:", "Music:") is the sound. Pure, so the server (which
 * formats the words just before a run, on either engine) and the tests share it.
 */

/** Words already in Kandinsky's form (a reused run, or someone who knows the tags): left as they are. */
export const inKandinskyForm = (text: string): boolean => /<S>[\s\S]*?<E>|<AUDCAP>[\s\S]*?<ENDAUDCAP>/.test(text);

/** Quoted words: straight, curly or angle quotes, at least one letter inside. */
const QUOTED = /"([^"\n]*\p{L}[^"\n]*)"|“([^”\n]*\p{L}[^”\n]*)”|«([^»\n]*\p{L}[^»\n]*)»|„([^“”\n]*\p{L}[^“”\n]*)[“”]/gu;

/** A sound line: "Sound: rain on the glass", on a line of its own or as the last sentence. */
const SOUND = /(?:^|\n|(?<=[.!?…]["”»]?)\s+)(?:sounds?|audio|music)\s*:\s*([^\n]+?)\s*$/i;

/**
 * The person's words in Kandinsky 6.0's form: quoted words become spoken lines, a closing "Sound: …" line the sound caption.
 * "She smiles and says “Look over there!” Sound: rain on the window" →
 * "She smiles and says <S>Look over there!<E> <AUDCAP>rain on the window<ENDAUDCAP>". Words already tagged pass through.
 */
export function kandinskyPrompt(words: string): string {
  const text = words.trim();
  if (!text || inKandinskyForm(text)) return text;
  let picture = text;
  let sound = "";
  const m = SOUND.exec(text);
  if (m) {
    sound = m[1].trim();
    picture = text.slice(0, m.index).trim();
  }
  picture = picture.replace(QUOTED, (_, a, b, c, d) => `<S>${String(a ?? b ?? c ?? d).trim()}<E>`);
  // A prompt that is only a sound line ("Sound: rain") is the sound caption alone.
  return sound ? `${picture ? `${picture} ` : ""}<AUDCAP>${sound}<ENDAUDCAP>` : picture;
}

/** The prompt box's hint for Kandinsky 6.0: how to give a character words, and the shot its sound. */
export const KANDINSKY_PLACEHOLDER = "Describe the shot. Put what someone says in quotes: she smiles and says “Look over there!” · end with Sound: … for ambience or music";
