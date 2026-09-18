// Evaluated in the same isolated QuickJS realm as scene scripts. No host handles.
export const boneGuestSource = String.raw`(function(Vec3, finite) {
  const identity=()=>[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
  const valid=m=>{if(!Array.isArray(m)||m.length!==16)throw Error('Invalid bone matrix');return m.map(finite);};
  class Mat4 {
    constructor(){this.elements=identity();}
    static identity(){return new Mat4();}
    static fromTranslation(v){return new Mat4().translation(v);}
    static fromScale(v){const m=new Mat4(),s=new Vec3(v);m.elements[0]=s.x;m.elements[5]=s.y;m.elements[10]=s.z;return m;}
    copy(){const m=new Mat4();m.elements=valid(this.elements);return m;}
    translation(v){if(v===undefined)return new Vec3(...this.elements.slice(12,15));const p=new Vec3(v);this.elements.splice(12,3,p.x,p.y,p.z);return this;}
    multiply(other){
      const out=new Mat4(),a=valid(this.elements);
      if(typeof other==='number'){out.elements=a.map(n=>finite(n*other));return out;}
      if(!(other instanceof Mat4))throw Error('Unsupported matrix product');
      const b=valid(other.elements);
      for(let c=0;c<4;c++)for(let r=0;r<4;r++){let n=0;for(let k=0;k<4;k++)n+=a[k*4+r]*b[c*4+k];out.elements[c*4+r]=finite(n);}
      return out;
    }
    inverse(){
      const a=valid(this.elements),rows=Array.from({length:4},(_,r)=>[...Array.from({length:4},(_,c)=>a[c*4+r]),...Array.from({length:4},(_,c)=>+(r===c))]);
      for(let c=0;c<4;c++){
        let p=c;for(let r=c+1;r<4;r++)if(Math.abs(rows[r][c])>Math.abs(rows[p][c]))p=r;
        if(Math.abs(rows[p][c])<1e-12)throw Error('Singular bone matrix');
        [rows[c],rows[p]]=[rows[p],rows[c]];const d=rows[c][c];for(let k=0;k<8;k++)rows[c][k]/=d;
        for(let r=0;r<4;r++)if(r!==c){const f=rows[r][c];for(let k=0;k<8;k++)rows[r][k]-=f*rows[c][k];}
      }
      const out=new Mat4();out.elements=Array.from({length:16},(_,i)=>finite(rows[i%4][4+Math.floor(i/4)]));return out;
    }
    translate(v){return this.multiply(Mat4.fromTranslation(v));}
    scale(v){return this.multiply(Mat4.fromScale(v));}
    transformPoint(v){const m=valid(this.elements),p=new Vec3(v);return new Vec3(m[0]*p.x+m[4]*p.y+m[8]*p.z+m[12],m[1]*p.x+m[5]*p.y+m[9]*p.z+m[13],m[2]*p.x+m[6]*p.y+m[10]*p.z+m[14]);}
    right(){return new Vec3(...this.elements.slice(0,3));}
    up(){return new Vec3(...this.elements.slice(4,7));}
    forward(){return new Vec3(...this.elements.slice(8,11));}
    toString(){return valid(this.elements).join(' ');}
  }
  const matrix=v=>{const m=new Mat4();m.elements=valid(v);return m;};
  const supported=new Set(['getBoneCount','getBoneIndex','getBoneParentIndex','getLocalBoneTransform','getBoneTransform','setLocalBoneTransform','setBoneTransform','getLocalBoneOrigin','setLocalBoneOrigin']);
  function api(data,key){
    if(!supported.has(key))return undefined;
    const bones=data.bones??[];
    const index=v=>{const i=typeof v==='string'?bones.findIndex(b=>b.name===v):v;if(!Number.isInteger(i)||i<0||i>=bones.length)throw Error('Unknown scene bone');return i;};
    const local=i=>matrix(data.boneWrites?.[i]??data.bonePose?.local[i]??bones[i].matrix);
    const world=(i,depth=0)=>{if(depth>=64)throw Error('Cyclic scene bone');const p=bones[i].parent;return (p<0?matrix(data.bonePose?.world??identity()):world(p,depth+1)).multiply(local(i));};
    const write=(i,m)=>{if(!(m instanceof Mat4))throw Error('Invalid bone transform');(data.boneWrites??={})[i]=valid(m.elements);};
    const methods={
      getBoneCount:()=>bones.length,
      getBoneIndex:name=>bones.findIndex(b=>b.name===name),
      getBoneParentIndex:v=>bones[index(v)].parent,
      getLocalBoneTransform:v=>local(index(v)),
      getBoneTransform:v=>world(index(v)),
      setLocalBoneTransform:(v,m)=>write(index(v),m),
      setBoneTransform:(v,m)=>{const i=index(v),p=bones[i].parent;write(i,(p<0?matrix(data.bonePose?.world??identity()):world(p)).inverse().multiply(m));},
      getLocalBoneOrigin:v=>local(index(v)).translation(),
      setLocalBoneOrigin:(v,p)=>{const i=index(v);write(i,local(i).translation(p));}
    };
    return Object.hasOwn(methods,key)?methods[key]:undefined;
  }
  return {Mat4,api};
})`;

export interface ScriptBonePose { id: number; world: number[]; local: number[][] }
export interface SceneScriptInput {
  cursor?: number[];
  bones?: ScriptBonePose[];
  sounds?: { id: number; playing: boolean; volume: number }[];
  events?: { type: "cursorDown" | "cursorUp" | "cursorClick" | "cursorMove" | "cursorEnter" | "cursorLeave"; ids: number[]; cursor: number[]; local?: Record<string, number[]> }[];
}
