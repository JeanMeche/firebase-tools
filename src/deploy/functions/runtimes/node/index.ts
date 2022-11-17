import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as portfinder from "portfinder";
import * as semver from "semver";
import * as spawn from "cross-spawn";
import fetch from "node-fetch";

import { FirebaseError } from "../../../../error";
import { getRuntimeChoice } from "./parseRuntimeAndValidateSDK";
import { logger } from "../../../../logger";
import { logLabeledWarning } from "../../../../utils";
import * as backend from "../../backend";
import * as build from "../../build";
import * as discovery from "../discovery";
import * as runtimes from "..";
import * as validate from "./validate";
import * as versioning from "./versioning";
import * as parseTriggers from "./parseTriggers";

const MIN_FUNCTIONS_SDK_VERSION = "3.20.0";
const NUM_RETRIES = 3;

/**
 *
 */
export async function tryCreateDelegate(
  context: runtimes.DelegateContext
): Promise<Delegate | undefined> {
  const packageJsonPath = path.join(context.sourceDir, "package.json");

  if (!(await promisify(fs.exists)(packageJsonPath))) {
    logger.debug("Customer code is not Node");
    return undefined;
  }

  // Check what runtime to use, first in firebase.json, then in 'engines' field.
  // TODO: This method loads the Functions SDK version which is then manually loaded elsewhere.
  // We should find a way to refactor this code so we're not repeatedly invoking node.
  const runtime = getRuntimeChoice(context.sourceDir, context.runtime);

  if (!runtime.startsWith("nodejs")) {
    logger.debug(
      "Customer has a package.json but did not get a nodejs runtime. This should not happen"
    );
    throw new FirebaseError(`Unexpected runtime ${runtime}`);
  }

  return new Delegate(context.projectId, context.projectDir, context.sourceDir, runtime);
}

// TODO(inlined): Consider moving contents in parseRuntimeAndValidateSDK and validate around.
// Those two files are currently pretty coupled (e.g. they borrow error messages from each other)
// and both files load package.json. Maybe the delegate should be constructed with a package.json and
// that can be passed to both methods.
export class Delegate {
  public readonly name = "nodejs";

  constructor(
    private readonly projectId: string,
    private readonly projectDir: string,
    private readonly sourceDir: string,
    public readonly runtime: runtimes.Runtime
  ) {}

  // Using a caching interface because we (may/will) eventually depend on the SDK version
  // to decide whether to use the JS export method of discovery or the HTTP container contract
  // method of discovery.
  _sdkVersion = "";
  get sdkVersion() {
    if (!this._sdkVersion) {
      this._sdkVersion = versioning.getFunctionsSDKVersion(this.sourceDir) || "";
    }
    return this._sdkVersion;
  }

  validate(): Promise<void> {
    versioning.checkFunctionsSDKVersion(this.sdkVersion);

    const relativeDir = path.relative(this.projectDir, this.sourceDir);
    validate.packageJsonIsValid(relativeDir, this.sourceDir, this.projectDir);

    return Promise.resolve();
  }

  async build(): Promise<void> {
    // TODO: consider running npm build or tsc. This is currently redundant with predeploy hooks,
    // so we would need to detect and notify users that they can just use idiomatic options instead.
  }

  watch(): Promise<() => Promise<void>> {
    // TODO: consider running npm run watch if it is defined or tsc watch when tsconfig.json is present.
    return Promise.resolve(() => Promise.resolve());
  }

  async serve(
    port: number,
    config: backend.RuntimeConfigValues,
    envs: backend.EnvironmentVariables
  ): Promise<() => Promise<void>> {
    const env: NodeJS.ProcessEnv = {
      ...envs,
      PORT: port.toString(),
      FUNCTIONS_CONTROL_API: "true",
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      NODE_ENV: process.env.NODE_ENV,
    };
    if (Object.keys(config || {}).length) {
      env.CLOUD_RUNTIME_CONFIG = JSON.stringify(config);
    }
    const childProcess = spawn("./node_modules/.bin/firebase-functions", [this.sourceDir], {
      env,
      cwd: this.sourceDir,
      stdio: [/* stdin=*/ "ignore", /* stdout=*/ "pipe", /* stderr=*/ "inherit"],
    });
    childProcess.stdout?.on("data", (chunk) => {
      logger.debug(chunk.toString());
    });

    // Assuming here that startup errors manifest in less than 5 seconds.
    await new Promise((resolve, reject) => {
      childProcess.once("error", reject);
      setTimeout(resolve, 5_000);
    });

    return Promise.resolve(async () => {
      const p = new Promise<void>((resolve, reject) => {
        childProcess.once("exit", resolve);
        childProcess.once("error", reject);
      });

      await fetch(`http://localhost:${port}/__/quitquitquit`);
      setTimeout(() => {
        if (!childProcess.killed) {
          childProcess.kill("SIGKILL");
        }
      }, 10_000);
      return p;
    });
  }

  async findRandomOpenPort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const basePort = Math.floor(Math.random() * 40000 + 10000);
      portfinder.getPort({ port: basePort }, (err, port) => {
        if (err) {
          reject(err);
        }
        resolve(port);
      });
    });
  }

  async discoverBuild(
    config: backend.RuntimeConfigValues,
    env: backend.EnvironmentVariables
  ): Promise<build.Build> {
    if (!semver.valid(this.sdkVersion)) {
      logger.debug(
        `Could not parse firebase-functions version '${this.sdkVersion}' into semver. Falling back to parseTriggers.`
      );
      return parseTriggers.discoverBuild(this.projectId, this.sourceDir, this.runtime, config, env);
    }
    if (semver.lt(this.sdkVersion, MIN_FUNCTIONS_SDK_VERSION)) {
      logLabeledWarning(
        "functions",
        `You are using an old version of firebase-functions SDK (${this.sdkVersion}). ` +
          `Please update firebase-functions SDK to >=${MIN_FUNCTIONS_SDK_VERSION}`
      );
      return parseTriggers.discoverBuild(this.projectId, this.sourceDir, this.runtime, config, env);
    }

    let discovered = await discovery.detectFromYaml(this.sourceDir, this.projectId, this.runtime);
    if (!discovered) {
      const port = await this.findRandomOpenPort();
      const kill = await (async () => {
        for (let i = 0; i < NUM_RETRIES; i++) {
          try {
            return await this.serve(port, config, env);
          } catch (e) {
            logger.debug(`Failed to bring up server with error: ${e}`);
          }
        }
        throw new FirebaseError(`Failed to bring up server after ${NUM_RETRIES} attempts.`);
      })();
      try {
        discovered = await discovery.detectFromPort(port, this.projectId, this.runtime);
      } finally {
        await kill();
      }
    }
    return discovered;
  }
}
