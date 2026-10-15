import type { Env, ObjectState } from "./bindings.js";
import { CellHost } from "./cell-host.js";

export class Solo extends CellHost {
  constructor(state: ObjectState, env: Env) {
    super(state, env, "solo");
  }
}
