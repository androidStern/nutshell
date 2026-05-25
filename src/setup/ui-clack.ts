import * as clack from "@clack/prompts";
import type { SetupCheck, SetupUI } from "./types";

export class SetupCancelledError extends Error {
  constructor() {
    super("setup cancelled");
    this.name = "SetupCancelledError";
  }
}

export class ClackSetupUI implements SetupUI {
  async intro(input: { title: string; body?: string }): Promise<void> {
    clack.intro(input.title);
    if (input.body) clack.note(input.body);
  }

  async note(input: { title?: string; body: string }): Promise<void> {
    clack.note(input.body, input.title);
  }

  async confirm(input: { title: string; body?: string; initialValue?: boolean }): Promise<boolean> {
    if (input.body) clack.note(input.body);
    return unwrap(await clack.confirm({ message: input.title, initialValue: input.initialValue }));
  }

  async select<T>(input: { title: string; options: Array<{ label: string; value: T; hint?: string }> }): Promise<T> {
    return unwrap(await clack.select<T>({ message: input.title, options: input.options as never }));
  }

  async multiselect<T>(input: { title: string; options: Array<{ label: string; value: T; hint?: string }>; initialValues?: T[] }): Promise<T[]> {
    return unwrap(
      await clack.multiselect({
        message: input.title,
        options: input.options as never,
        initialValues: input.initialValues,
        required: false,
      }),
    ) as T[];
  }

  async text(input: { title: string; placeholder?: string; initialValue?: string; sensitive?: boolean }): Promise<string> {
    const value = input.sensitive
      ? await clack.password({ message: input.title })
      : await clack.text({ message: input.title, placeholder: input.placeholder, defaultValue: input.initialValue });
    return String(unwrap(value));
  }

  async spinner<T>(input: { title: string; run: () => Promise<T> }): Promise<T> {
    const spinner = clack.spinner();
    spinner.start(input.title);
    try {
      const value = await input.run();
      spinner.stop(`${input.title}: done`);
      return value;
    } catch (error) {
      spinner.stop(`${input.title}: failed`);
      throw error;
    }
  }

  async ensure(input: {
    title: string;
    body?: string;
    check: () => Promise<SetupCheck>;
    repair: () => Promise<void>;
  }): Promise<SetupCheck> {
    const first = await this.spinner({ title: input.title, run: input.check });
    if (first.ok) return first;
    await this.note({ title: input.title, body: [input.body, first.message].filter(Boolean).join("\n\n") });
    const doRepair = await this.confirm({ title: "Try to fix this now?", initialValue: true });
    if (!doRepair) return first;
    await input.repair();
    return this.spinner({ title: `${input.title} verification`, run: input.check });
  }
}

function unwrap<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel("Setup cancelled.");
    throw new SetupCancelledError();
  }
  return value as T;
}
