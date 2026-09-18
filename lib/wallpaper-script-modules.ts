// These sources execute in the guest VM. Imports cannot resolve host modules,
// URLs, filesystem paths, or arbitrary wallpaper assets.
const modules: Record<string, string> = {
  WEMath: `
    export const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
    export const mix=(a,b,t)=>typeof a==='number'?a*(1-t)+b*t:a.mix(b,t);
    export const smoothstep=(lo,hi,x)=>{const t=clamp((x-lo)/(hi-lo),0,1);return t*t*(3-2*t);};
  `,
  WEColor: `
    export function hsv2rgb(v){
      const h=((v.x%1)+1)%1*6,s=Math.max(0,Math.min(1,v.y)),b=v.z;
      const channel=n=>b*(1-s*Math.max(0,Math.min(1,Math.min((n+h)%6,4-(n+h)%6))));
      return new Vec3(channel(5),channel(3),channel(1));
    }
  `,
};

export function sceneGuestModule(name: string): string {
  if (!Object.hasOwn(modules, name)) throw new Error("Unsupported SceneScript import");
  return modules[name];
}
