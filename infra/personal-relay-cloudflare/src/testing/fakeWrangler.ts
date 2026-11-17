import type {
  WranglerRunOptions,
  WranglerRunResult,
  WranglerRunner,
} from "../../scripts/deploy/types.ts";

export interface FakeWranglerCall {
  readonly args: ReadonlyArray<string>;
  readonly options: WranglerRunOptions | undefined;
}

export class FakeWranglerRunner implements WranglerRunner {
  readonly calls: Array<FakeWranglerCall> = [];
  readonly #results: Array<{ code: number; stdout: string; stderr: string }> = [];

  queue(result: Partial<WranglerRunResult> = {}): void {
    this.#results.push({
      code: result.code ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
  }

  run(args: ReadonlyArray<string>, options?: WranglerRunOptions): Promise<WranglerRunResult> {
    this.calls.push({ args: [...args], options });
    const result = this.#results.shift() ?? { code: 0, stdout: "", stderr: "" };
    return Promise.resolve(result);
  }
}
