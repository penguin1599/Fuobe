import {
  AppsSection,
  AssistSection,
  EffectsSection,
  HomeFooter,
  LiveEditSection,
  MotionsSection,
  OpenSourceSection,
  StartSection,
  StudiosSection,
} from "@/components/home/home-sections";
import { HomeBento } from "@/components/home/home-bento";
import { HomeView } from "@/components/home-view";
import { GoalRow } from "@/components/nav/goal-row";
import { ASSIST_SUGGESTIONS } from "@/lib/assist";
import { getPreset } from "@/lib/catalog";
import { HOME_TRY, homeShowcase, roundedDown } from "@/lib/home-showcase";
import { GOALS } from "@/lib/nav-model";
import { startQuotes, starterPriceLine } from "@/lib/starter-prices";

/** The goal bands' one-tap presets by name, read here so the catalog stays on the server. */
function goalTapNames(): Record<string, string> {
  return Object.fromEntries(
    GOALS.flatMap((g) =>
      g.taps.map((t) => {
        const p = getPreset(t.preset);
        if (!p) throw new Error(`The goal row names ${t.preset}, which isn't in the catalog`);
        return [t.preset, p.name];
      }),
    ),
  );
}

/**
 * The catalog stays on the server: Home gets slim cards, the numbers it quotes (each computed, lib/home-showcase.ts),
 * and what Start and the first-run guide cost. The first screen and the sections under the composer are server components.
 */
export default async function Page() {
  const home = await homeShowcase();
  return (
    <HomeView
      openModels={roundedDown(home.facts.openModels)}
      chips={HOME_TRY}
      assist={{ label: "Plan a perfume ad with Assist", href: `/assist?prompt=${encodeURIComponent(ASSIST_SUGGESTIONS[0])}` }}
      goals={<GoalRow names={goalTapNames()} />}
      bento={<HomeBento bento={home.bento} />}
      prices={starterPriceLine()}
      quotes={startQuotes()}
    >
      {/* Live edit is the highlight: its own section comes first, right under the first screen and the composer. */}
      <LiveEditSection />
      {/* Camera motions, then Effects. */}
      <MotionsSection facts={home.facts} motions={home.motions} />
      <EffectsSection facts={home.facts} effects={home.effects} />
      <AppsSection facts={home.facts} beforeAfter={home.beforeAfter} reveals={home.reveals} />
      <StudiosSection facts={home.facts} studios={home.studios} audioTools={home.audioTools} pills={home.pills} />
      <AssistSection facts={home.facts} skills={home.skills} />
      <OpenSourceSection facts={home.facts} newModels={home.newModels} />
      <StartSection />
      <HomeFooter />
    </HomeView>
  );
}
