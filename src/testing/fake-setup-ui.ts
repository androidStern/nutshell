import type { SetupCheck, SetupSelectOption, SetupUI } from "../setup/types";

export class FakeSetupUI implements SetupUI {
  readonly notes: string[] = [];
  confirms: boolean[] = [];
  multiselectValues: unknown[][] = [];
  selectedValues: unknown[] = [];
  textValues: string[] = [];

  async intro(input: { title: string; body?: string }): Promise<void> {
    this.notes.push([input.title, input.body].filter(Boolean).join("\n"));
  }

  async note(input: { title?: string; body: string }): Promise<void> {
    this.notes.push([input.title, input.body].filter(Boolean).join("\n"));
  }

  async confirm(): Promise<boolean> {
    return this.confirms.shift() ?? false;
  }

  async select<T>(input: { title: string; options: Array<SetupSelectOption<T>> }): Promise<T> {
    // Unscripted selects take the LAST option — by convention the escape
    // hatch (skip/exit) — so retry loops terminate instead of spinning.
    return (this.selectedValues.shift() as T | undefined) ?? input.options[input.options.length - 1]!.value;
  }

  async multiselect<T>(input: { title: string; options: Array<SetupSelectOption<T>>; initialValues?: T[] }): Promise<T[]> {
    return (this.multiselectValues.shift() as T[] | undefined) ?? input.initialValues ?? input.options.map((option) => option.value);
  }

  async text(input: { title: string; placeholder?: string; initialValue?: string; sensitive?: boolean }): Promise<string> {
    return this.textValues.shift() ?? input.initialValue ?? "";
  }

  async spinner<T>(input: { title: string; run: () => Promise<T> }): Promise<T> {
    return input.run();
  }

  async ensure(input: {
    title: string;
    body?: string;
    check: () => Promise<SetupCheck>;
    repair: () => Promise<void>;
  }): Promise<SetupCheck> {
    const first = await input.check();
    if (first.ok) return first;
    if (this.confirms.shift() ?? false) {
      await input.repair();
      return input.check();
    }
    return first;
  }
}
