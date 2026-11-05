/**
 * Prompt packs for the image studios (docs/research/higgsfield-image-studios.md §2, §3, §6, §7):
 * Photodump / Instadump packs, Fashion Factory templates, Character Sheet prompts, the drawn covers' hues and
 * tones, and the pure planning steps that turn them into generation requests.
 *
 * Catalog-free on purpose: the pages import it in the browser. What depends on the catalog or
 * the install (the models it has) comes in as `PlanCaps`; the server (src/server/photodump.ts)
 * fills those in and validates every request before creating it.
 *
 * Pack names, photo counts and template shot counts come from the generated research file
 * (studio-packs.generated.ts); the per-photo prompts are Fuobe's own. tests/image-studios.test.ts
 * checks that every pack has exactly as many prompts as its photo count.
 */
import type { ElementLora } from "./elements";
import { SOUL_MODEL_IDS } from "./soul-cards";
import { identityFor } from "./training";
import { FASHION_TEMPLATES, PHOTODUMP_PACKS, type FashionTemplateMeta, type PackMeta } from "./studio-packs.generated";
import type { Engine, GenerationRequest } from "./types";

// ---------------------------------------------------------------------------
// Drawn covers

/** A stable 0–359 hue from a string (FNV-1a). */
export function hueOf(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 360;
}

/** Evenly spread hues for the i-th cover of a set (the golden angle: neighbours never share a band). */
export const spreadHue = (i: number, offset = 18) => Math.round((offset + i * 137.508) % 360);

/**
 * How a drawn cover is treated (Fuobe ships no sample photos, so the cover is the only cue): black and
 * white with grain, a hard flash hotspot, red and blue gels, a pastel wash, film grain, a spotlight in
 * the dark, or a plain gradient in the look's hue.
 */
export type CoverTone = "mono" | "flash" | "gel" | "pastel" | "film" | "spot" | "plain";

const TONES: [RegExp, CoverTone][] = [
  [/black-and-white|\bb\s?&\s?w\b|\bbw\b|monochrome|noir|grayscale|greyscale/i, "mono"],
  [/\bgels?\b|neon|solaris/i, "gel"],
  [/flash|digicam|disposable|paparazzi/i, "flash"],
  [/pastel|candy|bubbles|\baqua\b/i, "pastel"],
  [/\bfilm\b|grain|noise|low-res|vintage|nostalgi|retro|35mm|vhs/i, "film"],
  [/spotlight|shadows|\bdark\b|moody|melanchol|night/i, "spot"],
];

/** A look's cover treatment from its name and description ("Retro BW" → mono, "80s horror" → gel). */
export function coverTone(...words: (string | undefined)[]): CoverTone {
  const text = words.filter(Boolean).join(" ");
  return TONES.find(([re]) => re.test(text))?.[1] ?? "plain";
}

// ---------------------------------------------------------------------------
// Photodump / Instadump packs

const SHOTS: Record<string, string[]> = {
  "sleepy-head": [
    "waking up tangled in white linen sheets, morning sun through sheer curtains, shot from above",
    "sitting up in bed holding a steaming mug with both hands, oversized pyjama shirt",
    "lying on their stomach reading a paperback on rumpled sheets, bare feet in the air",
    "hugging a pillow and laughing with eyes half closed, soft backlight",
    "a sleepy close-up on a pillow, messy hair, one hand under the cheek",
    "stretching by the bedroom window in pyjamas, warm golden light",
    "a breakfast tray on the duvet with a croissant and orange juice, sitting cross-legged on the bed",
    "a slightly blurry mirror selfie in the bedroom with bed hair",
    "under a fluffy blanket with only the face peeking out, playful look",
    "sitting on the edge of the bed pulling on fluffy socks",
    "scrolling a phone in bed at dawn, screen glow on the face, blue morning tones",
    "lying on the floor beside the bed with a record player and big headphones",
    "a sleepy smile while brushing teeth in a sunlit bathroom, in pyjamas",
    "curled up in an armchair by the bed in a knitted blanket with a cat on the lap",
    "overhead shot sprawled across the bed with arms out, pillows everywhere",
    "a silk eye mask pushed up on the forehead, sleepy grin, sitting in bed",
    "making the bed and throwing the duvet in the air, motion blur, bright morning",
  ],
  zen: [
    "seated cross-legged on a yoga mat in a sunlit studio full of plants, eyes closed",
    "pouring matcha in a minimal wooden tea room, loose linen clothes",
    "walking barefoot on a misty forest path in the early morning",
    "a downward-dog stretch on a wooden deck overlooking the sea",
    "meditating on a smooth rock beside a still lake at sunrise",
    "reading in a hammock under trees, dappled light, loose linen",
    "a close-up holding a ceramic tea cup with steam rising, eyes closed",
    "journaling on a tatami floor beside a low table with a curl of incense",
    "floating in a still pool shot from above, arms relaxed, soft daylight",
    "arranging white flowers in a vase on a bright windowsill, calm expression",
  ],
  "candid-glow": [
    "laughing mid-step on a sunny street, golden-hour backlight making the hair glow",
    "at a café terrace with an iced coffee, sun flare across the lens",
    "riding a bicycle along a seaside road at sunset, candid side angle",
    "eating an ice cream cone and squinting into the sun, warm tones",
    "leaning out of a car window with hair blowing in golden light",
    "a picnic on a blanket in a park, caught mid-laugh in golden-hour haze",
    "walking through tall grass at sunset, one hand brushing the grass",
    "looking back over the shoulder on a rooftop at golden hour",
    "dancing barefoot on the beach at dusk, slight motion blur, warm glow",
    "browsing a market stall, sunlight filtering through the awnings",
    "sitting on a pier with legs dangling over the water, the sun behind",
    "a candid close-up with sun-kissed skin and light through the leaves",
  ],
  "office-dresscode": [
    "walking into a glass office lobby in a tailored blazer, coffee in hand",
    "working at a standing desk with a laptop, crisp shirt, city view behind",
    "presenting at a whiteboard in a meeting room with a confident gesture",
    "commuting along a city sidewalk in a trench coat with a tote bag, morning light",
    "an elevator mirror selfie in office wear with an ID badge",
    "a lunch break on the office building steps with a salad, smart casual",
    "typing in a minimalist co-working space under a warm desk lamp in the evening",
    "on a phone call by a floor-to-ceiling window in a suit, skyline at dusk",
    "pouring coffee in a modern office kitchen, relaxed workwear",
    "crossing a busy crosswalk with a laptop bag, street-style snap",
    "sitting on the edge of a desk with arms crossed, editorial office portrait",
  ],
  "surreal-self": [
    "as a giant sitting among city skyscrapers with tiny cars around the feet",
    "as a tiny figure standing on the rim of a giant teacup on a breakfast table",
    "floating upside down in a room where the furniture hangs from the ceiling",
    "two copies of the same person having coffee together at one café table",
    "walking on clouds holding an umbrella under a pastel sky",
    "stepping out of a picture frame on a gallery wall",
    "sitting calmly in a bedroom flooded with clear water up to the shoulders",
    "surrounded by floating oranges in a blue void, studio light",
    "sitting on a crescent moon above a sleeping town",
    "held like a doll in a giant version of their own hand",
    "a mirror reflection that shows a different season than the room",
    "lying in a field of flowers that tower above them",
  ],
  "surreal-self-ii": [
    "riding a giant goldfish down a city street",
    "standing in a desert whose dunes are made of pink sugar",
    "climbing out of a giant open book with pages swirling around",
    "sitting inside a soap bubble floating over a lake",
    "climbing a staircase that leads up into the sky, long coat flowing",
    "under an umbrella where the rain falls upward, the street dry",
    "walking a giant cat on a leash through a tiny village",
    "several copies of themselves climbing a ladder into a cloud",
    "sitting in an armchair in the middle of a calm ocean",
    "hair flowing into ribbons of paint across a white studio",
  ],
  "alter-ego": [
    "as a 1920s jazz singer at a vintage microphone in a smoky club",
    "as a cyberpunk hacker with a neon visor in a rainy alley",
    "as a medieval knight in polished armour in a misty castle courtyard",
    "as an astronaut in a white spacesuit, helmet under the arm, on a launch pad",
    "as a rock star on stage with a guitar, stage lights and smoke",
    "as a film-noir detective in a trench coat under a streetlamp",
    "as a Renaissance oil portrait in velvet against a dark background",
    "as a racing driver in a race suit beside the car in the pit lane",
    "as a fantasy elf with silver hair in an enchanted forest",
    "as a 1980s aerobics instructor in a neon leotard in a retro gym",
    "as a royal in a gilded throne room wearing a crown",
    "as a wild-west outlaw in a cowboy hat in a dusty desert town",
  ],
  "cool-girl-dump": [
    "a flash mirror selfie in a vintage boutique fitting room, slip dress",
    "sitting on a Vespa on a Rome street in sunglasses, candid",
    "a close-up with glossy lips and gold hoops, direct flash at night",
    "lying on a striped beach towel reading a magazine, shot from above",
    "flipping through vinyl in a record store in an oversized leather jacket",
    "walking out of a bakery with a baguette, ballet flats, Paris street",
    "sitting cross-legged on a hotel bed with room service, in a robe",
    "in a car's passenger seat with feet on the dashboard, sunset light",
    "holding a martini at a dim cocktail bar in a black dress, film grain",
    "on a rooftop at golden hour in a linen set, wind in the hair",
    "getting ready at a vanity mirror with makeup scattered around",
    "trying on sunglasses at a flea market, candid street snap",
    "in a bright pilates studio in a matching set",
    "sitting on a stone wall by the sea in a white sundress, laughing",
    "a night-time flash photo on a city street holding a pizza box",
  ],
  "male-archive": [
    "leaning on a vintage car in a white tee and jeans at golden hour",
    "in a barber's chair getting a fade, warm candid interior",
    "walking a dog in a park in a knit sweater on a fresh morning",
    "a gym locker-room mirror selfie after a workout",
    "on a motorcycle at a gas station at night, leather jacket, neon light",
    "reading a newspaper at a corner café in an overcoat with an espresso",
    "on the deck of a sailing boat in a linen shirt, sun and spray",
    "cooking in a home kitchen with sleeves rolled up, steam rising",
    "on a basketball court at dusk holding a ball, streetwear",
    "adjusting cufflinks in a tailored suit, hotel room window light",
    "hiking a mountain ridge with a backpack, wide vista",
    "at a record shop counter with headphones around the neck",
    "in a late-night diner booth with a burger, red neon, film grain",
    "on a city rooftop in a bomber jacket at blue hour, skyline behind",
    "a black-and-white portrait with stubble and a slight smirk, hard window light",
  ],
  "winter-special": [
    "catching snowflakes on the tongue in a snowy street, knit beanie",
    "holding a hot chocolate with marshmallows by a frosty window",
    "ice skating on an outdoor rink under string lights",
    "wrapped in a chunky scarf in a snowy forest, breath visible in the cold",
    "decorating a Christmas tree with warm fairy lights in a cosy sweater",
    "mid-throw in a snowball fight, laughing, motion blur",
    "by a crackling fireplace in a wooden cabin in wool socks",
    "walking through a Christmas market at night between glowing stalls",
    "making a snow angel in fresh snow, shot from above",
  ],
  "aura-farming": [
    "leaning against a shaded wall, hands in pockets, looking away, totally calm",
    "standing at the bow of a boat with wind in the hair, an unbothered gaze",
    "low angle walking toward the camera in a long coat, city at dusk",
    "sitting on the stairs of an empty subway station under moody fluorescent light",
    "back to the camera overlooking the city from a rooftop at blue hour",
    "in a hoodie under a single streetlight in the rain, a calm stare",
    "sunglasses on, chin up, harsh noon sun and deep shadows",
    "half the face lit by a window and the rest in darkness, quiet confidence",
    "standing in a field at golden hour with a jacket over the shoulder",
    "sitting on the hood of a car at night with the headlights on, relaxed",
    "walking through drifting smoke on an empty street, cinematic backlight",
    "a close-up glance over the shoulder, film grain, muted tones",
    "lying on a skate ramp staring at the sky, wide angle",
    "on a train looking out of the window at dusk, reflection on the glass",
  ],
  looksmaxing: [
    "a clean studio headshot with a soft key light and a sharp jawline on a neutral backdrop",
    "a three-quarter portrait with golden rim light and well-groomed hair",
    "a close-up with clear, glowing skin under a beauty-dish light",
    "a sculpted side profile against a dark background",
    "a confident smile in a crisp white shirt, high-key light",
    "a portrait in a black turtleneck with dramatic Rembrandt light",
    "a fresh haircut, editorial close-up",
    "an outdoor golden-hour portrait with a shallow depth of field",
    "a gym mirror shot with good posture in a fitted tee, flattering light",
    "a low-angle power portrait against a clear blue sky",
    "a close-up with direct eye contact and a subtle smile, 85mm lens",
    "a high-contrast black-and-white portrait with defined features",
    "an editorial portrait leaning on a column in a minimalist space",
    "a candid laugh by a window in natural light",
    "a sharp suit portrait on a city street with blurred lights behind",
  ],
  "2000s-nostalgia": [
    "a digital-camera flash selfie in a bedroom covered in posters, low-rise jeans",
    "a flip phone to the ear, tinted sunglasses, butterfly clips",
    "at a mall food court with a smoothie in a velour tracksuit",
    "a photo-booth snap making a peace sign",
    "jumping on a backyard trampoline, overexposed flash, date stamp in the corner",
    "on a bean bag with a handheld game console",
    "at a house party with cheap flash, red-eye and glitter",
    "in front of a CRT TV holding a DVD case, frosted lip gloss",
    "getting into a yellow taxi with shopping bags, paparazzi flash",
    "in a trucker hat and rhinestone tee in a parking lot at night",
    "a selfie from above, the classic 2000s angle, heavy flash",
    "on a sunny beach shot on a disposable camera",
    "in an arcade lit by neon game screens",
    "riding a kick scooter down a suburban street",
    "in a bedroom with a lava lamp and fairy lights, white earbuds",
  ],
  "editorial-shots": [
    "a high-fashion portrait on a seamless red backdrop, bold styling",
    "sitting on a sculptural chair in a gallery in an avant-garde outfit",
    "full length in a long coat on an empty runway under a spotlight",
    "a beauty close-up with graphic eyeliner and glossy skin",
    "leaning in the doorway of a brutalist building in a monochrome outfit",
    "lying on a marble floor with draped fabric, shot from above",
    "walking into the wind with a flowing silk scarf in a white studio",
    "a portrait framed by palm leaves, tropical editorial",
    "a hand on the face with dramatic shadows from window blinds",
    "standing on a ladder in a minimal studio in an oversized suit",
    "a backlit silhouette with rim light and haze",
    "sitting on a vintage car in a desert, couture styling",
    "a cover-style portrait with a direct gaze and soft grain",
    "jumping mid-air in a pleated dress against a blue sky",
    "a reflection in a fractured mirror, artful composition",
  ],
};

/** How each pack's photos look as a set (added to every photo's prompt). */
const PACK_LOOK: Record<string, string> = {
  "sleepy-head": "Soft, cosy morning light, candid phone-photo feel",
  zen: "Calm natural light, muted earthy tones",
  "candid-glow": "Warm golden-hour glow, candid lifestyle snapshot",
  "office-dresscode": "Clean editorial workwear photography",
  "surreal-self": "Surreal, playful photo-manipulation look, photoreal",
  "surreal-self-ii": "Surreal, dreamlike photo-manipulation, photoreal",
  "alter-ego": "Cinematic costume portrait with production-quality styling",
  "cool-girl-dump": "Effortless, candid 35mm film snapshot",
  "male-archive": "Candid 35mm film snapshot, effortless menswear",
  "winter-special": "Cosy winter photo with warm light against the cold",
  "aura-farming": "Moody, cinematic, effortless-cool photo",
  looksmaxing: "Flattering, sharp portrait photography",
  "2000s-nostalgia": "Early-2000s point-and-shoot flash photo",
  "editorial-shots": "High-end fashion magazine editorial",
};

/** Each pack's drawn cover, set by hand so the 14 read apart (hues are spread by position). */
const PACK_TONE: Record<string, CoverTone> = {
  "sleepy-head": "pastel",
  "alter-ego": "spot",
  "cool-girl-dump": "film",
  "male-archive": "film",
  "winter-special": "pastel",
  "aura-farming": "spot",
  "2000s-nostalgia": "flash",
  "editorial-shots": "mono",
  "surreal-self-ii": "gel",
};

export interface Pack extends PackMeta {
  shots: string[];
  look: string;
  /** User packs: one reference photo per shot (the photo to recreate). */
  refs?: string[];
  custom?: boolean;
  /** The drawn cover: its hue and treatment. */
  hue: number;
  tone: CoverTone;
}

export const PACKS: Pack[] = PHOTODUMP_PACKS.map((p, i) => ({ ...p, shots: SHOTS[p.id] ?? [], look: PACK_LOOK[p.id] ?? "", hue: spreadHue(i), tone: PACK_TONE[p.id] ?? "plain" }));
export const getPack = (id: string) => PACKS.find((p) => p.id === id);

/** A user's own pack (Instadump's "Create pack"): up to 15 reference photos to recreate. */
export const MAX_PACK_REFS = 15;
/** The one selfie or photo an Instadump starts from. */
export const MAX_SELFIE_MB = 20;
export const PHOTODUMP_ASPECTS = ["auto", "9:16", "3:4", "2:3", "1:1", "4:3", "16:9", "3:2"];
export const DEFAULT_ASPECT = "3:4";

export interface CustomPackLike {
  id: string;
  name: string;
  refs: string[];
}

/** A user pack as a Pack: one shot per reference photo. */
export function customPack(p: CustomPackLike): Pack {
  return {
    id: p.id,
    name: p.name,
    count: p.refs.length,
    description: `${p.refs.length} reference photo${p.refs.length === 1 ? "" : "s"}`,
    inferred: false,
    product: "instadump",
    shots: p.refs.map(() => "the same pose, framing, setting, outfit style, lighting and colour grade as the reference photo"),
    look: "",
    refs: p.refs,
    custom: true,
    hue: hueOf(p.id),
    tone: "plain",
  };
}

/** Who the photos are of: a saved character (@element) or one uploaded selfie (Instadump, no training). */
export type PhotoSubject =
  | { kind: "element"; handle: string; name: string; references: string[]; loras: ElementLora[] }
  /** One photo of the person (`name`: an account's own character, which starts from its first photo). */
  | { kind: "selfie"; url: string; name?: string };

/** What the server knows about this install, for planning. */
export interface PlanCaps {
  /**
   * Models this install has (open-source workflows can be missing) and offers (Settings → Models & licences); with
   * `engine`, a Fuobe Original's half on that engine.
   */
  has?: (id: string, engine?: Engine) => boolean;
}

/** Fuobe Soul: a character with a trained Soul ID makes its photos there, on either engine (build plan O3). */
export const PHOTODUMP_SOUL = "fuobe-soul";

/**
 * Instadump's Original (build plan O10): an edit model with the photos as references, one Fuobe prompt per pack photo.
 * In the cloud hosted Qwen-Image-Edit 2511; on your GPU Qwen-Image 2.1 (up to 4 references). It also makes a
 * character's photos before a Soul ID.
 */
export const PHOTO_EDIT: Record<Engine, string> = { cloud: "qwen-image-edit-2511-cloud", open: "oss-qwen-image-21" };
/** The edit model your GPU runs first: Qwen-Image 2.1 (up to 4 references). */
export const OPEN_PHOTO_EDIT = PHOTO_EDIT.open;
/** Its 8-step Turbo (up to 4 references). */
export const OPEN_PHOTO_EDIT_TURBO = "oss-qwen-image-21-turbo";
/**
 * Krea 2 Identity Edit: restages the person in one photo (a new place, pose or outfit, the same face). With two pictures
 * it reads the scene first and the person last (its likeness boost goes to the last one).
 */
export const OPEN_IDENTITY_EDIT = "oss-krea2-identity-edit";

/** The models a pack's photos can run on, the default first after Fuobe Soul (which needs a trained Soul ID). */
export const PHOTODUMP_MODELS: Record<Engine, string[]> = {
  cloud: [PHOTODUMP_SOUL, PHOTO_EDIT.cloud, "nano-banana-pro", "nano-banana-2-1", "seedream-5-pro"],
  open: [PHOTODUMP_SOUL, OPEN_PHOTO_EDIT, OPEN_IDENTITY_EDIT, OPEN_PHOTO_EDIT_TURBO],
};

const EDIT_NAMES: Record<string, string> = {
  "qwen-image-edit-2511-cloud": "Qwen-Image-Edit 2511",
  "oss-qwen-image-21": "Qwen-Image 2.1",
  "oss-qwen-image-21-turbo": "Qwen-Image 2.1 Turbo",
  "oss-krea2-identity-edit": "Krea 2 Identity Edit",
  "nano-banana-pro": "Nano Banana Pro",
  "nano-banana-2-1": "Nano Banana 2.1",
  "seedream-5-pro": "Seedream 5.0 Pro",
};

/** The character's Soul ID that runs on Fuobe Soul on this engine (a demo training's stand-in doesn't count). */
export const soulIdOf = (s: PhotoSubject, engine: Engine): ElementLora | undefined => (s.kind === "element" ? identityFor(s.loras, { id: PHOTODUMP_SOUL, engine }) : undefined);

/**
 * Which model makes a subject's photos: Fuobe Soul with the character's trained Soul ID (its LoRA) where there is
 * one, on either engine; otherwise a multi-reference edit model with their photos. `pick` is the user's choice among
 * PHOTODUMP_MODELS, honoured when it can work.
 */
export function photodumpModel(subject: PhotoSubject, engine: Engine, _caps: PlanCaps, pick?: string, custom = false): { modelId: string; note?: string } {
  const trained = soulIdOf(subject, engine);
  if (!custom && trained && (!pick || pick === PHOTODUMP_SOUL)) return { modelId: PHOTODUMP_SOUL };
  // Say why when the pick (or a character without a Soul ID) ends up on an edit model: the engine's first one
  // (Qwen-Image-Edit 2511 in the cloud, Qwen-Image 2.1 on your GPU) unless another of the list is picked.
  const edits = PHOTODUMP_MODELS[engine].filter((id) => id !== PHOTODUMP_SOUL);
  const fallback = pick && edits.includes(pick) ? pick : edits[0];
  const name = EDIT_NAMES[fallback] ?? fallback;
  const note =
    pick === PHOTODUMP_SOUL && custom
      ? `Your own packs recreate each reference photo — ${name} runs them`
      : pick === PHOTODUMP_SOUL && subject.kind === "selfie" && subject.name
        ? // An account's own character (its photos, no Soul ID): the edit model keeps its face from its photo.
          `${name} makes ${subject.name}'s photos from their saved photo, keeping their face`
        : pick === PHOTODUMP_SOUL && subject.kind === "selfie"
        ? `Fuobe Soul needs a character with a trained Soul ID — ${name} works from your photo`
        : pick === PHOTODUMP_SOUL || (engine === "open" && subject.kind === "element" && !trained && !custom)
          ? `No Soul ID yet — ${name} works from the character's photos (train them for Fuobe Soul on the Elements page)`
          : undefined;
  return { modelId: fallback, note };
}

const KEEP_FACE = "Keep their exact face, identity, skin tone and hair, in a freshly composed new photo";

/**
 * One photo's prompt for a subject: an @mention for saved characters, image 1 for a selfie (image `selfieIndex` when
 * the model takes the person last).
 */
export function shotPrompt(pack: Pick<Pack, "look" | "custom">, shot: string, subject: PhotoSubject, refIndex?: number, selfieIndex = 1): string {
  const who = subject.kind === "element" ? `@${subject.handle}` : `the person in image ${selfieIndex}`;
  const look = pack.look ? ` ${pack.look}.` : "";
  if (pack.custom && refIndex) {
    const lead = who.charAt(0).toUpperCase() + who.slice(1);
    return `${lead} recreated in image ${refIndex}: ${shot}. Replace the person in image ${refIndex} with them. ${KEEP_FACE}.${look}`.trim();
  }
  return `A photo of ${who}, ${shot}.${look}${subject.kind === "selfie" ? ` ${KEEP_FACE}.` : ""}`;
}

export interface PhotodumpInput {
  pack: Pack;
  subject: PhotoSubject;
  engine: Engine;
  aspectRatio?: string;
  modelId?: string;
}

export interface PhotodumpPlan {
  modelId: string;
  requests: GenerationRequest[];
  notes: string[];
}

/**
 * One request per photo of the pack, in order ("Photo 3 of 15"), each making one image. Saved
 * characters are @mentioned (the server turns that into their trained Soul ID LoRA or reference photos);
 * a selfie goes in as image 1. User packs add their reference photo after the subject; on Krea 2 Identity Edit, which
 * reads the scene first and the person last, the reference photo goes first and a saved character is one of their photos.
 */
export function planPhotodump(input: PhotodumpInput, caps: PlanCaps): PhotodumpPlan {
  const { pack, subject } = input;
  if (!pack.shots.length) throw new Error("This pack has no photos");
  if (subject.kind === "element" && !subject.references.length && !subject.loras.length) throw new Error(`Add a photo of ${subject.name} first`);
  const notes: string[] = [];
  const route = photodumpModel(subject, input.engine, caps, input.modelId, !!pack.custom);
  if (route.note) notes.push(route.note);
  const n = pack.shots.length;
  const aspect = input.aspectRatio && input.aspectRatio !== "auto" ? input.aspectRatio : undefined;
  // Krea 2 Identity Edit takes the scene first and the person last, and reads two pictures as two people: a saved
  // character goes in as one of their photos (an @mention would attach two), and a user pack's reference leads.
  const sceneFirst = route.modelId === OPEN_IDENTITY_EDIT;
  const onePhoto = sceneFirst && subject.kind === "element" ? subject.references[0] : undefined;
  const person: PhotoSubject = onePhoto ? { kind: "selfie", url: onePhoto } : subject;
  const requests = pack.shots.map((shot, i): GenerationRequest => {
    const own = person.kind === "selfie" ? [person.url] : [];
    const ref = pack.refs?.[i];
    // User packs: the reference goes after the identity images; @mention references come after those (applyMentions appends).
    const images = ref ? (sceneFirst ? [ref, ...own] : [...own, ref]) : own;
    const refIndex = ref ? (sceneFirst ? 1 : own.length + 1) : undefined;
    const selfieIndex = ref && sceneFirst ? 2 : 1;
    return {
      feature: "photodump",
      modelId: route.modelId,
      // Fuobe Soul runs on both engines: the run's engine picks its half.
      engine: input.engine,
      prompt: shotPrompt(pack, shot, person, refIndex, selfieIndex),
      inputs: images.length ? { images } : undefined,
      params: { numOutputs: 1, ...(aspect && { aspectRatio: aspect }) },
      step: { label: `Photo ${i + 1} of ${n}`, index: i, of: n },
    };
  });
  return { modelId: route.modelId, requests, notes };
}

// ---------------------------------------------------------------------------
// Fashion Factory

interface TemplateLook {
  /** The set: backdrop, light and mood. */
  look: string;
  /** One prompt per photo of the photoset. */
  shots: string[];
}

const LOOKS: Record<string, TemplateLook> = {
  "ultra-bold": {
    look: "a bold, saturated colour-blocked studio set with primary-colour backdrops and props, hard flash and graphic shadows",
    shots: [
      "full body standing on a cobalt-blue seamless next to a red cube",
      "crouching low on a yellow floor against a green wall, wide angle",
      "a three-quarter close-up against a hot-pink backdrop, hard flash",
      "sitting on an orange stool with legs crossed in front of a blue backdrop",
      "mid-stride across colour-blocked floor panels, a hint of motion",
      "leaning on a giant red letter-shaped prop, playful pose",
      "back view looking over the shoulder against a purple backdrop",
      "arms raised in a dynamic pose in front of a split two-tone wall",
      "lying on a mint-green floor, shot from above",
      "hands on hips, cropped at the chest to show the outfit",
      "jumping in front of a yellow wall with a crisp hard shadow",
    ],
  },
  "blue-green-gradient": {
    look: "a studio set on a smooth blue-to-green gradient backdrop with soft, even light",
    shots: [
      "full body from the front, centred on the gradient",
      "a three-quarter view with one hand in a pocket",
      "seated on a white plinth in a relaxed pose",
      "walking in profile with the gradient behind",
      "a close-up portrait in soft beauty light",
      "back view showing the back of the outfit",
      "a low-angle full-body power pose",
      "leaning forward on a stool, elbows on the knees",
      "mid-turn with the fabric in motion",
      "waist-up with arms crossed",
    ],
  },
  "street-style-paparazzi": {
    look: "a street-style shoot with paparazzi flash energy: city sidewalks, taxis, night flash and onlookers",
    shots: [
      "walking out of a hotel at night under bursts of camera flash, sunglasses on",
      "crossing a busy crosswalk, candid, telephoto compression",
      "stepping out of a black car, flash reflections on the pavement",
      "waiting at a crosswalk with a coffee, looking away",
      "a hand raised to block the camera, flash glare",
      "leaning on a shop window at dusk, the full outfit visible",
      "walking past a crowd of photographers, motion blur behind",
      "sitting on a street bench with legs crossed under an overcast sky",
      "a close-up glance over the shoulder in direct flash",
    ],
  },
  "view-from-the-top": {
    look: "high-angle and top-down fashion framing, graphic floors and patterns",
    shots: [
      "shot top-down lying on a patterned rug",
      "seen from a balcony high above, standing alone on a stone plaza",
      "a bird's-eye view standing on the white stripes of a crosswalk",
      "an overhead shot sitting on a staircase with the outfit spread out",
      "a high angle looking up at the camera, wide lens",
      "top-down lying on a bed of flowers with arms spread",
    ],
  },
  "light-blue-studio": {
    look: "a clean pale-blue seamless studio with soft, diffused light and minimal props",
    shots: [
      "full body from the front in a relaxed stance",
      "a three-quarter view with a slight smile",
      "seated on a pale-blue cube",
      "a side profile with the chin up",
      "a close-up portrait",
      "walking toward the camera",
      "back view",
      "leaning against the seamless wall",
      "hands in the hair, playful",
      "a crouching pose with the whole outfit visible",
    ],
  },
  "red-room": {
    look: "a monochrome all-red set: red walls, red floor and red props under warm, hard light",
    shots: [
      "full body standing in the middle of the red room",
      "sitting in a red velvet armchair",
      "lying on the red floor, shot from above",
      "leaning in a red door frame",
      "a close-up portrait against the red walls",
      "walking down a red corridor",
      "holding a red telephone receiver",
      "back view at a red-curtained window",
      "a dramatic low-angle full-body shot",
    ],
  },
};

export interface FashionTemplate extends FashionTemplateMeta {
  look: string;
  photoset: string[];
  /** Two colours for the drawn preview. */
  hues: [number, number];
}

const TEMPLATE_HUES: Record<string, [number, number]> = {
  "ultra-bold": [25, 255],
  "blue-green-gradient": [230, 160],
  "street-style-paparazzi": [270, 45],
  "view-from-the-top": [95, 30],
  "light-blue-studio": [215, 205],
  "red-room": [20, 5],
};

export const FASHION: FashionTemplate[] = FASHION_TEMPLATES.map((t) => ({
  ...t,
  look: LOOKS[t.id]?.look ?? t.description,
  photoset: LOOKS[t.id]?.shots ?? [],
  hues: TEMPLATE_HUES[t.id] ?? [hueOf(t.id), (hueOf(t.id) + 60) % 360],
}));
export const getTemplate = (id: string) => FASHION.find((t) => t.id === id);

/**
 * Fashion Factory's models per step (build plan O10): Fuobe Try-On (FLUX.2 [klein] 4B + the try-on LoRA) dresses the
 * base shot on both engines, FASHN and Nano Banana Pro stay as cloud choices, and on your GPU Qwen-Image 2.1 Turbo
 * (then Qwen-Image 2.1 at 25 steps) dresses it when the try-on can't run: its second picture is a garment, not a person. Qwen-Image-Edit 2511 makes the photoset in the
 * cloud, Nano Banana Pro a choice; on your GPU Qwen-Image 2.1 makes it, Krea 2 Identity Edit (a new pose and place,
 * the same person) a choice.
 */
export const TRYON_MODEL = "fuobe-tryon";
export const FASHION_MODELS = {
  outfit: { cloud: [TRYON_MODEL, "fashn-tryon", "nano-banana-pro"], open: [TRYON_MODEL, OPEN_PHOTO_EDIT_TURBO, OPEN_PHOTO_EDIT] },
  photoset: { cloud: [PHOTO_EDIT.cloud, "nano-banana-pro"], open: [OPEN_PHOTO_EDIT, OPEN_IDENTITY_EDIT] },
} as const;

/**
 * A Fashion step's model: the one picked when it is one of the step's on this engine, else the first of them this
 * install offers (caps.has: its switch, and a recipe LoRA it can't run without), else the first (its run then
 * refuses, naming the switch to turn back on).
 */
export function fashionModel(step: keyof typeof FASHION_MODELS, engine: Engine, pick?: string, caps?: Pick<PlanCaps, "has">): string {
  const list: readonly string[] = FASHION_MODELS[step][engine];
  if (pick && list.includes(pick)) return pick;
  return list.find((id) => !caps?.has || caps.has(id, engine)) ?? list[0];
}

const element = (s: PhotoSubject) => (s.kind === "element" ? `@${s.handle}` : "the person in image 1");

/** Step 2: four base shots of the character in the template's set, 3:4. */
export function fashionBaseRequest(t: FashionTemplate, subject: PhotoSubject, engine: Engine, caps: PlanCaps): GenerationRequest {
  if (subject.kind === "element" && !subject.references.length && !subject.loras.length) throw new Error(`Add a photo of ${subject.name} first`);
  const { modelId } = photodumpModel(subject, engine, caps);
  // A saved character by @mention; one photo of them (an account's character) as image 1, its face kept.
  const photo = subject.kind === "selfie" ? subject.url : undefined;
  return {
    feature: "fashion",
    modelId,
    engine,
    prompt: `A full-body fashion photo of ${element(subject)} in ${t.look}. A natural, relaxed model pose looking at the camera, simple fitted basics so the outfit can be changed later, photorealistic, sharp detail.${photo ? ` ${KEEP_FACE}.` : ""}`,
    ...(photo && { inputs: { images: [photo] } }),
    params: { aspectRatio: "3:4", numOutputs: 4 },
    step: { label: "Base shots", index: 0, of: 3 },
  };
}

/** Step 4: the base shot wearing the uploaded outfit (try-on, or an edit that dresses them). */
export function fashionOutfitRequest(t: FashionTemplate, base: string, garment: string, engine: Engine, modelId?: string, caps?: Pick<PlanCaps, "has">): GenerationRequest {
  const id = fashionModel("outfit", engine, modelId, caps);
  const tryon = id === TRYON_MODEL || id === "fashn-tryon";
  return {
    feature: "fashion",
    modelId: id,
    // Fuobe Try-On runs on both engines: the run's engine picks its half.
    ...(id === TRYON_MODEL && { engine }),
    op: "edit",
    prompt: tryon
      ? "a full-body photo of a person. Replace the outfit with the garment shown in the reference image, with its fabric, colour, pattern, logo and fit. The final image is a full body shot."
      : `Dress the person in image 1 in the outfit or product from image 2: its exact fabric, colour, pattern, logo and fit. Keep their face, pose and ${t.name.toLowerCase()} set from image 1.`,
    inputs: { images: [base, garment] },
    params: { numOutputs: 2, ...(tryon ? {} : { aspectRatio: "3:4" }) },
    step: { label: "Outfit", index: 1, of: 3 },
  };
}

/** Step 5: one photo per template shot, from the dressed image (the step's first model, or the one picked). */
export function fashionPhotosetRequests(t: FashionTemplate, dressed: string, engine: Engine, pick?: string, caps?: Pick<PlanCaps, "has">): GenerationRequest[] {
  const modelId = fashionModel("photoset", engine, pick, caps);
  const n = t.photoset.length;
  return t.photoset.map((shot, i) => ({
    feature: "fashion",
    modelId,
    op: "edit",
    prompt: `The same person in exactly the same outfit as image 1, ${shot}, in ${t.look}. Keep their face, hair, the garment's fabric, colour, pattern and logo identical; a new fashion photo, photorealistic.`,
    inputs: { images: [dressed] },
    params: { numOutputs: 1, aspectRatio: "3:4" },
    step: { label: `Photoset ${i + 1} of ${n}`, index: i, of: n },
  }));
}

// The wizard: template → character → pick 1 of 4 base shots → outfit → photoset.

export type FashionStep = "template" | "character" | "generation" | "clothing" | "photoset";
export const FASHION_STEPS: FashionStep[] = ["template", "character", "generation", "clothing", "photoset"];

export interface FashionState {
  step: FashionStep;
  templateId?: string;
  elementId?: string;
  /** The base shots' generation ids, and the one picked. */
  baseIds: string[];
  base?: string;
  garment?: { url: string; uploading: boolean };
  outfitIds: string[];
  outfit?: string;
  photosetBatch?: string;
}

export const FASHION_START: FashionState = { step: "template", baseIds: [], outfitIds: [] };

export type FashionAction =
  | { type: "template"; id: string }
  | { type: "element"; id: string }
  | { type: "next" }
  | { type: "back" }
  | { type: "goto"; step: FashionStep }
  | { type: "baseStarted"; ids: string[] }
  | { type: "pickBase"; url: string }
  | { type: "garment"; garment?: { url: string; uploading: boolean } }
  | { type: "outfitStarted"; ids: string[] }
  | { type: "pickOutfit"; url: string }
  | { type: "photosetStarted"; batchId: string }
  /** A failed base shot or outfit was retried: its new generation(s) take its place. */
  | { type: "retried"; from: string; to: string[] }
  | { type: "reset" };

/** The exact message Higgsfield shows when a step can't go on, or null. */
export function fashionBlocker(s: FashionState, action: "next" | "outfit" | "photoset" = "next"): string | null {
  if (s.step === "template" || !s.templateId) return s.templateId ? null : "Template required";
  if (s.step === "character") return s.elementId ? null : "Pick or create a character first";
  if (s.step === "generation") return s.base ? null : "Select an image at the generation step";
  if (s.step === "clothing") {
    if (action === "outfit") return !s.garment ? "No product to generate" : s.garment.uploading ? "Please wait for the image to finish processing before generating" : null;
    return s.outfit ? null : "Select an image at the clothing step";
  }
  return null;
}

export function fashionReducer(s: FashionState, a: FashionAction): FashionState {
  const at = FASHION_STEPS.indexOf(s.step);
  switch (a.type) {
    case "template":
      // A new set invalidates everything made in the old one.
      return a.id === s.templateId ? s : { ...FASHION_START, templateId: a.id, elementId: s.elementId };
    case "element":
      return a.id === s.elementId ? s : { ...s, elementId: a.id, baseIds: [], base: undefined, outfitIds: [], outfit: undefined, photosetBatch: undefined };
    case "next":
      if (fashionBlocker(s) || at === FASHION_STEPS.length - 1) return s;
      return { ...s, step: FASHION_STEPS[at + 1] };
    case "back":
      return at > 0 ? { ...s, step: FASHION_STEPS[at - 1] } : s;
    case "goto": {
      // Only back to a step already reached (or the next one once this one is done).
      const to = FASHION_STEPS.indexOf(a.step);
      if (to <= at) return { ...s, step: a.step };
      let cur = s;
      while (FASHION_STEPS.indexOf(cur.step) < to) {
        const next = fashionReducer(cur, { type: "next" });
        if (next === cur) return cur;
        cur = next;
      }
      return cur;
    }
    case "baseStarted":
      return { ...s, step: "generation", baseIds: a.ids, base: undefined, outfitIds: [], outfit: undefined, photosetBatch: undefined };
    case "pickBase":
      return { ...s, base: a.url, outfitIds: a.url === s.base ? s.outfitIds : [], outfit: a.url === s.base ? s.outfit : undefined };
    case "garment":
      return { ...s, garment: a.garment };
    case "outfitStarted":
      return { ...s, outfitIds: [...a.ids, ...s.outfitIds], outfit: undefined };
    case "pickOutfit":
      return { ...s, outfit: a.url };
    case "photosetStarted":
      return { ...s, step: "photoset", photosetBatch: a.batchId };
    case "retried": {
      const swap = (ids: string[]) => (ids.includes(a.from) ? ids.flatMap((id) => (id === a.from ? a.to : [id])) : ids);
      const baseIds = swap(s.baseIds);
      const outfitIds = swap(s.outfitIds);
      return baseIds === s.baseIds && outfitIds === s.outfitIds ? s : { ...s, baseIds, outfitIds };
    }
    case "reset":
      return FASHION_START;
  }
}

// ---------------------------------------------------------------------------
// Character Sheet ("Build your AI avatar")

export const SHEET_MAX_REFS = 5;

export const SHEET_PROMPT =
  "A character turnaround sheet of the person in the reference images: full-body front view, three-quarter view, side profile and back view side by side, plus a close-up of the face, on a seamless light-grey studio backdrop with soft, even light. The same face, hairstyle, body and outfit in every view; photorealistic, natural skin texture, a clean picture made only of the views.";

/** The sheet from reference photos on your GPU: Qwen-Image 2.1 at 25 steps (its Turbo misses big camera turns). */
export const SHEET_OPEN_MODEL = "oss-qwen-image-21";
/** Qwen-Image 2.1 takes up to 4 reference photos. */
export const SHEET_OPEN_REFS = 4;

/** From Reference: 1–5 photos → a turnaround sheet (Nano Banana Pro, or Qwen-Image 2.1 with up to 4). */
export function sheetFromReference(images: string[], engine: Engine, details?: string): { request: GenerationRequest; notes: string[] } {
  if (!images.length) throw new Error("Upload at least 1 image");
  if (images.length > SHEET_MAX_REFS) throw new Error(`Maximum ${SHEET_MAX_REFS} images`);
  const notes: string[] = [];
  const max = engine === "open" ? SHEET_OPEN_REFS : SHEET_MAX_REFS;
  if (images.length > max) notes.push(`Qwen-Image 2.1 takes ${max} photos — the first ${max} are used`);
  // The open workflow has no size setting: the sheet comes out in the first photo's shape.
  if (engine === "open") notes.push("Qwen-Image 2.1 keeps the shape of your first photo — put a landscape photo first for a wide sheet");
  const extra = details?.trim().replace(/[.\s]+$/, "");
  return {
    request: {
      feature: "character-sheet",
      modelId: engine === "open" ? SHEET_OPEN_MODEL : "nano-banana-pro",
      op: "edit",
      prompt: extra ? `${SHEET_PROMPT} ${extra}.` : SHEET_PROMPT,
      inputs: { images: images.slice(0, max) },
      params: { aspectRatio: engine === "open" ? undefined : "16:9", numOutputs: 1 },
    },
    notes,
  };
}

/**
 * Build from scratch: the Soul Cast form → its casting sheet model on each engine: the Soul Cast sheet graph on your
 * GPU, Fuobe Soul in the cloud (Nano Banana Pro when this install has switched Fuobe Soul off).
 */
export function castSheetModel(engine: Engine, caps: PlanCaps): string {
  if (engine === "open") return !caps.has || caps.has("oss-zimage-soul-cast") ? "oss-zimage-soul-cast" : "oss-z-image-turbo";
  return !caps.has || caps.has(SOUL_MODEL_IDS.soul, "cloud") ? SOUL_MODEL_IDS.soul : "nano-banana-pro";
}

/** Soul Cast fields that only make sense for some answers (mirrors SOUL_CAST_FIELDS[].when in cinema.ts). */
const BEARDED = ["Beard", "Long beard", "Mustache", "Short beard"];
export function castFieldVisible(key: string, values: Record<string, unknown>): boolean {
  if (key === "facial_hair") return values.gender !== "Female";
  if (key === "facial_hair_color") return values.gender !== "Female" && BEARDED.includes(String(values.facial_hair));
  return true;
}

/** A Soul Cast field as the page gets it from the server (cinema.ts's SOUL_CAST_FIELDS without `when`). */
export interface CastFieldData {
  key: string;
  label: string;
  tab: string;
  question?: string;
  kind: "list" | "ruler" | "multi";
  options: (string | number)[];
  default?: string | number;
  format?: string;
  manual?: boolean;
}

export type CastAnswers = Record<string, string | number | string[] | undefined>;

/** Higgsfield's Randomize (mirrors cinema.ts randomizeCast): genre, era, race, gender, age and archetype. */
export function randomCast(fields: CastFieldData[], values: CastAnswers, rand: () => number = Math.random): CastAnswers {
  const next: CastAnswers = { ...values };
  for (const key of ["genre", "era", "race", "gender", "age", "archetype"]) {
    const f = fields.find((x) => x.key === key);
    if (f?.options.length) next[key] = f.options[Math.floor(rand() * f.options.length) % f.options.length];
  }
  if (next.gender === "Female") {
    delete next.facial_hair;
    delete next.facial_hair_color;
  }
  return next;
}

/** A starting name for the saved character (mirrors cinema.ts castName): "Rebel 30", "Western lead". */
export function castNameFor(values: CastAnswers): string {
  if (values.archetype) return values.age ? `${values.archetype} ${values.age}` : String(values.archetype);
  return values.genre ? `${values.genre} lead` : "Cast member";
}
