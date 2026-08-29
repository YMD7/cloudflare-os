import { env, RpcStub as NativeRpcStub, WorkerEntrypoint } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  CODE_MODE_HARNESS,
  CodeModeCancellation,
  OverseerDurableObject,
} from "../src/overseer.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    LOADER: WorkerLoader;
  }
}

interface CancellationEntrypoint extends WorkerEntrypoint {
  run(
    self: undefined,
    callbackResolvers: undefined,
    restoreForger: undefined,
    cancellation: NativeRpcStub<CodeModeCancellation>,
  ): Promise<void>;
}

function makeAlarmOverseer(impl: {
  refreshRunningAgentKeepaliveAlarm(): Promise<boolean>;
  deliverReadyExternalMessageResponses(): Promise<void>;
}): OverseerDurableObject {
  let overseer = Object.create(OverseerDurableObject.prototype) as OverseerDurableObject;
  Object.assign(overseer, {impl});
  return overseer;
}

describe("Overseer alarm lifecycle", () => {
  it("returns after refreshing the running-agent heartbeat", async () => {
    let impl = {
      refreshRunningAgentKeepaliveAlarm: vi.fn(async () => true),
      deliverReadyExternalMessageResponses: vi.fn(async () => {}),
    };

    await makeAlarmOverseer(impl).alarm();

    expect(impl.refreshRunningAgentKeepaliveAlarm).toHaveBeenCalledOnce();
    expect(impl.deliverReadyExternalMessageResponses).not.toHaveBeenCalled();
  });

  it("delivers external responses when no agent heartbeat is needed", async () => {
    let impl = {
      refreshRunningAgentKeepaliveAlarm: vi.fn(async () => false),
      deliverReadyExternalMessageResponses: vi.fn(async () => {}),
    };

    await makeAlarmOverseer(impl).alarm();

    expect(impl.deliverReadyExternalMessageResponses).toHaveBeenCalledOnce();
  });
});

describe("Code Mode cancellation", () => {
  it("ends a running dynamic worker when cancellation is requested", async () => {
    let workerDef: WorkerLoaderWorkerCode = {
      compatibilityDate: "2026-02-01",
      mainModule: "harness.js",
      modules: {
        "harness.js": CODE_MODE_HARNESS,
        "agent.js": "export default async function() { await new Promise(() => {}); }",
      },
      globalOutbound: null,
    };
    let entrypoint = env.LOADER.load(workerDef).getEntrypoint<CancellationEntrypoint>();
    let controller = new AbortController();
    let cancellation = new CodeModeCancellation(controller.signal);

    try {
      let running = entrypoint.run(undefined, undefined, undefined, cancellation);
      controller.abort(new Error("User requested to stop agent."));

      await expect(running).resolves.toBeUndefined();
    } finally {
      cancellation[Symbol.dispose]();
    }
  });
});
