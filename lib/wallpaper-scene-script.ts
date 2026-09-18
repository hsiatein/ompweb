import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from "quickjs-emscripten-core";
import type { SceneText } from "./wallpaper-scene-types";

let modulePromise: Promise<QuickJSWASMModule> | undefined;
export function sceneScriptModule() {
  return modulePromise ??= Promise.all([
    import("quickjs-emscripten-core"), import("@jitl/quickjs-wasmfile-release-sync"),
  ]).then(([core, variant]) => core.newQuickJSWASMModuleFromVariant(variant.default));
}

// Only JSON values cross this boundary. No host functions, DOM, network, module
// loader or filesystem are installed in the guest JS environment.
export class SceneTextScript {
  private deadline = 0;
  private vm: QuickJSContext;
  private updateFunction?: QuickJSHandle;
  private disposed = false;
  private constructor(module: QuickJSWASMModule) {
    this.vm = module.newContext();
    this.vm.runtime.setMemoryLimit(8 * 1024 * 1024);
    this.vm.runtime.setMaxStackSize(256 * 1024);
    this.vm.runtime.setInterruptHandler(() => performance.now() > this.deadline);
  }
  static async create(text: SceneText, now = Date.now()) {
    if (!text.script || text.script.length > 128 * 1024) throw new Error("Invalid SceneScript source");
    const runner = new SceneTextScript(await sceneScriptModule());
    try {
      runner.deadline = performance.now() + 50;
      const properties = JSON.stringify(text.properties);
      if (properties.length > 64 * 1024) throw new Error("SceneScript properties exceed limit");
      runner.evaluate(`
        const overrides = JSON.parse(${JSON.stringify(properties)});
        globalThis.__sceneNow = ${Number(now)};
        const RealDate = Date;
        globalThis.Date = class extends RealDate {
          constructor(...args) { super(...(args.length ? args : [globalThis.__sceneNow])); }
          static now() { return globalThis.__sceneNow; }
        };
        globalThis.createScriptProperties = function() {
          const values = Object.create(null), builder = Object.create(null);
          for (const method of ['addCheckbox','addText','addSlider','addCombo','addColor','addVec2','addVec3']) {
            builder[method] = function(p) {
              values[p.name] = Object.prototype.hasOwnProperty.call(overrides, p.name)
                ? overrides[p.name] : p.value ?? p.options?.[0]?.value;
              return builder;
            };
          }
          builder.finish = () => values;
          return builder;
        };
      `).dispose();
      const exports = runner.evaluate(text.script, true);
      try {
        const setup = runner.evaluate(`(function(exports, initial) {
          let text=initial,first=true;
          const write=v=>{if(typeof v!=='string'||v.length>8192)throw Error('Invalid scene text');text=v;};
          globalThis.thisLayer=new Proxy(Object.create(null),{
            get(_,key){if(key==='text')return text;throw Error('Unsupported text layer API');},
            set(_,key,value){if(key!=='text')throw Error('Unsupported text layer API');write(value);return true;}
          });
          if(typeof exports.init==='function'){const v=exports.init(text);if(v!==undefined)write(v);}
          return function(value){
            if(!first)write(value);first=false;
            if(typeof exports.update==='function'){const v=exports.update(text);if(v!==undefined)write(v);}
            return text;
          };
        })`);
        const value = runner.vm.newString(text.value);
        try {
          runner.updateFunction=runner.result(runner.vm.callFunction(setup,runner.vm.undefined,exports,value));
        } finally { setup.dispose();value.dispose(); }
      } finally { exports.dispose(); }
      return runner;
    } catch (e) { runner.dispose(); throw e; }
  }
  private result(result: ReturnType<QuickJSContext["evalCode"]>) {
    if (result.error) {
      // Never serialize guest objects: getters/toJSON could execute more code.
      result.error.dispose();
      throw new Error("SceneScript failed: unsupported API, invalid code, or execution limit");
    }
    return result.value;
  }
  private evaluate(source: string, module = false) {
    return this.result(this.vm.evalCode(source, "wallpaper.js", { type: module ? "module" : "global" }));
  }
  update(value: string, now = Date.now(), budgetMs = 8) {
    if (this.disposed) throw new Error("SceneScript is disposed");
    this.deadline = performance.now() + Math.min(8, budgetMs);
    const timestamp = this.vm.newNumber(now), input = this.vm.newString(value);
    try {
      this.vm.setProp(this.vm.global, "__sceneNow", timestamp);
      const output = this.result(this.vm.callFunction(this.updateFunction!, this.vm.undefined, input));
      try {
        if (this.vm.typeof(output) !== "string") throw new Error("Text SceneScript must return a string");
        const text = this.vm.getString(output);
        if (text.length > 8192) throw new Error("SceneScript text output exceeds limit");
        return text;
      } finally { output.dispose(); }
    } finally { input.dispose(); timestamp.dispose(); }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.updateFunction?.dispose(); this.vm.dispose();
  }
}
