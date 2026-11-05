/**
 * Radio-group keyboard pattern for a row of role="radio" buttons (segmented controls): the arrow
 * keys (and Home / End) move to the next option and pick it, and only the picked option is a Tab
 * stop. Put `onKeyDown={radioKeys}` on the role="radiogroup" element and
 * `tabIndex={radioTab(selected)}` on each option.
 */
export function radioKeys(e: React.KeyboardEvent<HTMLElement>) {
  const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[e.key];
  if (step === undefined && e.key !== "Home" && e.key !== "End") return;
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not([disabled]):not([aria-disabled="true"])')];
  if (!radios.length) return;
  e.preventDefault();
  const at = radios.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "Home" ? 0 : e.key === "End" ? radios.length - 1 : (Math.max(at, 0) + step + radios.length) % radios.length;
  radios[next].focus();
  radios[next].click();
}

export const radioTab = (selected: boolean) => (selected ? 0 : -1);
