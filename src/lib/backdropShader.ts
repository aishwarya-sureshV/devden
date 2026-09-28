// Ported verbatim from the workbench layout design mockup.
// Scene modes 0-19; uniforms: R T M I F Lm Hs Hd P1 P2.
export const BACKDROP_FRAGMENT_SHADER = /* glsl */ `
#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec2 R;uniform float T,M,I,F,Lm,Hs;uniform vec2 Hd,P1,P2;
vec3 tint(vec3 c,float k){float Y=dot(c,vec3(.299,.587,.114));vec2 iq=vec2(dot(c,vec3(.596,-.274,-.322)),dot(c,vec3(.211,-.523,.312)));float m=length(iq);float an=atan(iq.y,iq.x);float w0=exp(3.*cos(an)),w1=exp(3.*cos(an-2.094)),w2=exp(3.*cos(an-4.189));vec2 dir=normalize(Hd*w0+P1*w1+P2*w2+1e-4);float w=Hs>0.?clamp(Hs*4.,0.,1.)*k:0.;iq=mix(iq,dir*m*1.15,w)*mix(1.,.12+.88*Hs,step(.001,Hs))+Hd*Y*.14*Hs*k;return vec3(Y+.956*iq.x+.621*iq.y,Y-.272*iq.x-.647*iq.y,Y-1.106*iq.x+1.703*iq.y);}
float h(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
vec2 h2(vec2 p){return vec2(h(p),h(p+17.13));}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+1.),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;mat2 m=mat2(1.6,1.2,-1.2,1.6);for(int i=0;i<5;i++){v+=a*n(p);p=m*p;a*=.5;}return v;}
vec3 pal(float x){return .5+.5*cos(6.2832*(vec3(0.,.33,.67)+x));}
vec3 aurora(vec2 p,float t){p*=1.4;
 vec2 q=vec2(fbm(p+vec2(0.,t*.06)),fbm(p+vec2(5.2,1.3)-t*.05));
 vec2 r=vec2(fbm(p+3.*q+vec2(1.7,9.2)+t*.04),fbm(p+3.*q+vec2(8.3,2.8)-t*.03));
 float f=fbm(p+3.*r);
 vec3 c=mix(vec3(.05,.07,.17),vec3(.10,.45,.52),clamp(f*f*2.4,0.,1.));
 c=mix(c,vec3(.40,.18,.58),clamp(length(q)-.45,0.,1.)*.85);
 c=mix(c,vec3(1.,.55,.36),clamp(r.x*r.x*r.x*1.8,0.,1.)*.6);
 return c*(f*f*1.5+.28);}
vec3 contour(vec2 p,float t){
 float f=fbm(p*1.1+vec2(t*.025,-t*.018)+fbm(p*.6-t*.012)*.9);
 float k=f*16.,w=fwidth(k);
 float d=abs(fract(k+.5)-.5),line=1.-smoothstep(0.,w*1.4,d);
 float dm=abs(fract(k/4.+.5)-.5)*4.,major=1.-smoothstep(0.,w*2.2,dm);
 float pulse=.3+.7*pow(.5+.5*sin(k*.4-t*.45),3.);
 vec3 c=mix(vec3(.25,.78,.82),vec3(.62,.45,1.),smoothstep(.3,.62,f));
 c=mix(c,vec3(1.,.62,.42),smoothstep(.62,.82,f));
 return vec3(.025,.03,.045)+c*.05*f+c*(line*.26+major*.28)*pulse;}
vec3 caustic(vec2 uv,float t){
 vec2 p=uv*5.-250.,i=p;float c=1.,inten=.005;
 for(int k=0;k<5;k++){float tt=t*.22*(1.-(3.5/float(k+1)));i=p+vec2(cos(tt-i.x)+sin(tt+i.y),sin(tt-i.y)+cos(tt+i.x));c+=1./length(vec2(p.x/(sin(i.x+tt)/inten),p.y/(cos(i.y+tt)/inten)));}
 c/=5.;c=1.17-pow(c,1.4);float v=clamp(pow(abs(c),8.),0.,1.);
 vec3 base=mix(vec3(.02,.05,.08),vec3(.03,.10,.14),fbm(uv*1.5+t*.02));
 return base+vec3(.30,.78,.85)*v*.42;}
vec3 nebula(vec2 p,float t){
 vec2 d=p+vec2(t*.012,t*.005);
 float cl=fbm(d*1.8+fbm(d*1.3+t*.02)*1.6),cl2=fbm(d*2.6-vec2(t*.01,0.)+4.);
 vec3 c=vec3(.02,.02,.045);
 c+=vec3(.30,.12,.42)*smoothstep(.35,.95,cl)*.9;
 c+=vec3(.08,.34,.40)*smoothstep(.45,1.,cl2)*.8;
 c+=vec3(.9,.45,.3)*pow(smoothstep(.55,1.,cl*cl2*1.6),2.)*.35;
 for(int L=0;L<3;L++){float fl=float(L);vec2 g=(d*(1.+fl*.35))*(26.+fl*18.)+fl*11.;vec2 id=floor(g),f=fract(g)-.5;float r=h(id);
  if(r>.9){vec2 o=h2(id+3.)-.5;float s=smoothstep(.09,0.,length(f-o*.7));c+=s*(.35+.25*sin(t*.6+r*60.))*mix(vec3(.8,.9,1.),vec3(1.,.8,.6),h(id+9.));}}
 return c;}
vec3 silk(vec2 uv,float asp,float t){
 vec3 c=vec3(.022,.022,.035)+vec3(.03,.015,.05)*uv.y;float x=uv.x*asp;
 for(int i=0;i<30;i++){float fi=float(i),b=floor(fi/10.),j=mod(fi,10.);
  float y=.18+b*.32+.13*sin(x*1.05+t*.16+b*2.1+j*.06)*cos(x*.41-t*.1+b*1.7)+(j-4.5)*.01*(1.+.9*sin(x*.8+t*.18+b));
  c+=pal(b*.19+j*.015+x*.04+.55)*(.0011/(abs(uv.y-y)+.0016))*.1;}
 return c;}
vec3 cells(vec2 p,float t){p*=2.6;
 vec2 i=floor(p),f=fract(p);float d1=8.,d2=8.,id=0.;
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 g=vec2(float(x),float(y));vec2 o=.5+.42*sin(t*.22+6.2832*h2(i+g));vec2 r=g+o-f;float d=dot(r,r);
  if(d<d1){d2=d1;d1=d;id=h(i+g);}else if(d<d2)d2=d;}
 float e=sqrt(d2)-sqrt(d1),edge=1.-smoothstep(0.,.045,e);
 vec3 hc=pal(id*.35+.52);float sh=.5+.5*sin(t*.35+id*20.);
 return vec3(.028,.03,.045)+hc*(.05+.08*sh)*(1.-sqrt(d1)*.7)+mix(vec3(.6,.75,.9),hc,.5)*edge*.2;}
vec3 snow(vec2 uv,float asp,float t){
 vec3 c=mix(vec3(.10,.12,.18),vec3(.025,.035,.07),uv.y);
 float x=uv.x*asp;
 float h1=.26+.08*fbm(vec2(x*1.2,1.))+.04*sin(x*1.7);
 c=mix(c,vec3(.07,.085,.12),smoothstep(h1+.004,h1-.004,uv.y));
 float h0=.13+.06*fbm(vec2(x*2.,7.));
 c=mix(c,vec3(.13,.15,.20),smoothstep(h0+.004,h0-.004,uv.y));
 c+=vec3(.05,.06,.09)*fbm(vec2(x,uv.y*2.)*1.5+vec2(t*.01,0.))*(1.-uv.y);
 for(int L=0;L<4;L++){float fl=float(L);float sc=4.+fl*5.;float sp=.075-fl*.014;
  vec2 q=vec2(x,uv.y)*sc;q.y+=t*sp*sc;q.x+=sin(q.y*.25+fl*3.+t*.2)*.35;
  vec2 id=floor(q),f=fract(q)-.5;float r=h(id+fl*7.);
  if(r>.4){vec2 o=(h2(id+fl)-.5)*.55;o.x+=.12*sin(t*.7+r*30.);float sz=mix(.075,.05,fl/3.)*(.5+.7*r);
   c+=smoothstep(sz,sz*.15,length(f-o))*mix(.50,.20,fl/3.)*vec3(.88,.93,1.);}}
 return c;}
vec3 bokeh(vec2 p,float t){vec3 c=mix(vec3(.035,.035,.06),vec3(.05,.045,.07),p.y);
 for(int L=0;L<3;L++){float fl=float(L);vec2 q=p*(2.6+fl*1.8)+vec2(t*.015*(fl+1.),fl*5.);vec2 id=floor(q),f=fract(q)-.5;float r=h(id+fl*3.);
  if(r>.4){vec2 o=(h2(id+fl*9.)-.5)*.4;float d=length(f-o);float rad=.2+.12*h(id+2.);
   float b=smoothstep(rad,rad-.06,d)*(.65+.35*smoothstep(rad-.12,rad-.02,d));
   vec3 hc=mix(vec3(1.,.62,.35),vec3(.45,.68,1.),step(.72,r));hc=mix(hc,vec3(1.,.42,.48),step(.9,r));
   c+=hc*b*(.11-fl*.025)*(.75+.25*sin(t*.25+r*40.));}}
 return c;}
vec3 dl(vec2 UV,float t){
 vec2 g=vec2(7.,3.5);vec2 uv=UV*g;uv.y+=t*.05*g.y;
 vec2 id=floor(uv),gv=fract(uv)-.5;float r=h(id);float tt=t*.7+r*6.2832;
 float x=(r-.5)*.6+.05*sin(UV.y*40.+r*10.);
 float y=-sin(tt+sin(tt+sin(tt)*.5))*.38;y-=(gv.x-x)*(gv.x-x)*.8;
 vec2 dp=(gv-vec2(x,y))*vec2(1.,2.);float drop=smoothstep(.13,.08,length(dp));
 vec2 tp=vec2(gv.x-x,(fract(gv.y*7.)-.5)/7.)*vec2(1.,2.);
 float trail=smoothstep(.06,.03,length(tp))*step(y+.06,gv.y)*(1.-smoothstep(y,.5,gv.y));
 float on=step(.25,r);
 return vec3(dp*drop+tp*trail,drop+trail*.5)*on;}
vec3 sdl(vec2 UV,float t){vec2 uv=UV*26.;vec2 id=floor(uv),gv=fract(uv)-.5;float r=h(id+.7);vec2 o=(h2(id+4.)-.5)*.6;vec2 d=gv-o;
 float life=fract(t*.04+r);float s=smoothstep(.22,.12,length(d))*step(.72,r)*(1.-smoothstep(.75,1.,life));return vec3(d*s,s);}
vec3 rain(vec2 p,float t){
 vec3 a=dl(p,t),b=dl(p*1.4+vec2(7.,3.),t*1.15),s=sdl(p,t);
 vec2 off=a.xy*.09+b.xy*.065+s.xy*.03;float m=clamp(a.z+b.z+s.z,0.,1.);
 vec3 c=bokeh(p-off*2.,t);
 c=c*(1.+m*.5)+vec3(.02,.025,.03)+m*.02;
 return c;}
vec3 shore(vec2 uv,float asp,float t){
 float x=uv.x*asp;float y=uv.y+(x-asp*.5)*.16;
 float wob=fbm(vec2(x*1.4,3.))*.08;
 float sw=.5+.5*sin(t*.3);sw=sw*sw*(3.-2.*sw);
 float emin=.28+wob;float edge=emin+sw*.09+.02*fbm(vec2(x*4.,t*.12));
 float wet=smoothstep(emin-.05,emin+.02,y);
 vec3 sand=mix(vec3(.16,.135,.115),vec3(.075,.07,.075),wet)*(.92+.16*n(vec2(x,y)*260.));
 sand+=vec3(.12,.14,.16)*wet*pow(fbm(vec2(x*20.,y*30.)),4.)*.8;
 float depth=y-edge;
 vec3 w=mix(vec3(.07,.21,.23),vec3(.02,.07,.11),smoothstep(0.,.55,depth));
 float ph=fract(depth*4.5+t*.09+fbm(vec2(x*2.,y*3.)+t*.04)*.7);
 float ribs=smoothstep(0.,.03,ph)*(1.-smoothstep(.03,.14,ph))*(1.-smoothstep(0.,.6,depth));
 float fe=(1.-smoothstep(0.,.02+.025*fbm(vec2(x*8.,t*.3)),depth))*(.55+.45*fbm(vec2(x*14.,y*24.)+t*.2));
 float gl=pow(fbm(vec2(x*16.,y*28.)+vec2(t*.15,-t*.08)),6.)*7.*smoothstep(.05,.3,depth)*(1.-smoothstep(.0,.55,abs(x-asp*.68)));
 w+=vec3(.60,.66,.68)*(fe*.55+ribs*.14)+vec3(.7,.8,.85)*gl*.35;
 return mix(sand,w,smoothstep(-.004,.004,depth));}
vec3 fireflies(vec2 p,vec2 uv,float t){
 vec3 c=mix(vec3(.025,.05,.045),vec3(.01,.02,.03),uv.y);
 c+=vec3(.03,.06,.05)*fbm(p*1.4+vec2(t*.025,0.));
 c+=vec3(.04,.07,.06)*(1.-smoothstep(0.,.4,uv.y))*fbm(p*3.-vec2(t*.04,0.));
 for(int L=0;L<3;L++){float fl=float(L);float sc=3.+fl*2.;vec2 q=p*sc+fl*13.;vec2 id=floor(q);float r=h(id+fl);
  if(r>.35){vec2 o=.5+.24*vec2(sin(t*.25*(.5+r)+r*20.),cos(t*.19*(.5+h(id+1.))+r*9.));vec2 d=(fract(q)-o)/sc;float dd=dot(d,d);
   float bl=smoothstep(.15,1.,sin(t*.5+r*50.)*.5+.5);
   c+=vec3(.85,.92,.45)*(exp(-dd*30000.)*.9+exp(-dd*900.)*.3)*bl*(1.-fl*.28);}}
 return c;}
vec3 golden(vec2 uv,vec2 p,float t){
 vec3 sky=mix(vec3(.34,.17,.17),vec3(.06,.06,.15),smoothstep(0.,1.,uv.y));
 sky=mix(sky,vec3(.48,.26,.18),(1.-smoothstep(0.,.3,uv.y))*.6);
 vec2 q=p*vec2(1.1,2.3)+vec2(t*.018,0.);
 float cl=fbm(q+fbm(q*.7+t*.008)*.8),lit=fbm(q+fbm(q*.7+t*.008)*.8+vec2(0.,-.06));
 float dens=smoothstep(.42,.78,cl);
 vec3 cc=mix(vec3(.11,.07,.15),vec3(.80,.45,.33),clamp((cl-lit)*5.+.45,0.,1.)*(1.-uv.y*.55));
 return mix(sky,cc,dens*.85)*.78;}
vec3 pond(vec2 p,vec2 uv,float t){
 vec3 c=mix(vec3(.035,.075,.085),vec3(.02,.04,.06),uv.y)+vec3(.02,.05,.05)*fbm(p*2.+t*.02);
 vec2 q=p*2.4;vec2 i0=floor(q);float rip=0.;
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 id=i0+vec2(float(x),float(y));float r=h(id);float per=4.+3.*r;float k=t/per+r;float ph=fract(k);
  vec2 cen=id+.2+.6*h2(id+floor(k)*1.7);float w=length(q-cen)-ph*.9;
  rip+=sin(w*30.)*exp(-w*w*50.)*(1.-ph)*(1.-ph);}
 return c+vec3(.28,.48,.52)*max(rip,0.)*.32-vec3(.01)*max(-rip,0.);}
vec3 beach(vec2 uv,float asp,float t){
 float x=uv.x*asp;float hz=.58;
 vec3 sky=mix(vec3(.34,.20,.26),vec3(.07,.08,.18),smoothstep(hz,1.,uv.y));
 float sun=exp(-length(vec2(x-asp*.7,(uv.y-hz-.06)*1.6))*6.);
 sky+=vec3(1.,.6,.4)*sun*.55+vec3(.07,.05,.08)*fbm(vec2(x*1.4+t*.015,uv.y*7.));
 if(uv.y>hz)return sky;
 float sw=.5+.5*sin(t*.35);sw=sw*sw*(3.-2.*sw);
 float shore=.19+.03*sin(x*1.3+.5)+.05*sw+.01*fbm(vec2(x*5.,t*.2));
 if(uv.y<shore){vec3 sand=vec3(.22,.17,.14)*(.9+.12*n(vec2(x,uv.y)*300.));
  float wet=smoothstep(shore-.09,shore,uv.y)*(1.-sw*.3);
  sand=mix(sand,vec3(.12,.11,.14)+vec3(.35,.22,.18)*exp(-abs(x-asp*.7)*2.5)*.4,wet*.7);return sand;}
 float d=hz-uv.y;float z=1./(d+.015);
 vec3 sea=mix(vec3(.18,.16,.22),vec3(.04,.11,.15),smoothstep(0.,.25,d));
 float ph=z*.32-t*.22+fbm(vec2(x*2.,z*.15))*.7;
 sea+=vec3(.5,.6,.65)*pow(.5+.5*sin(ph*6.2832),8.)*.2*smoothstep(.02,.2,d);
 sea+=vec3(1.,.75,.55)*pow(n(vec2(x*50.,z*3.-t*.6)),10.)*exp(-abs(x-asp*.7)*3.)*1.6;
 float fd=uv.y-shore;
 float foam=(1.-smoothstep(0.,.025+.025*fbm(vec2(x*6.,t*.3)),fd))*(.55+.45*fbm(vec2(x*12.,uv.y*30.)+t*.2));
 float bw=shore+.07+.04*sin(t*.35+1.2);float br=exp(-pow((uv.y-bw)*55.,2.))*(.4+.6*fbm(vec2(x*7.-t*.25,1.)));
 return sea+vec3(.75,.8,.82)*(foam*.6+br*.4);}
vec3 mountains(vec2 uv,float asp,float t){
 float x=uv.x*asp;
 vec3 c=mix(vec3(.34,.22,.30),vec3(.06,.08,.17),smoothstep(.25,1.,uv.y));
 c+=vec3(.95,.58,.42)*exp(-length(vec2(x-asp*.3,(uv.y-.5)*2.))*3.)*.28;
 float cl=fbm(vec2(x*1.1+t*.02,uv.y*4.));
 c=mix(c,vec3(.58,.44,.50),smoothstep(.55,.8,cl)*smoothstep(.5,.85,uv.y)*.35);
 for(int i=0;i<5;i++){float fi=float(i);
  float ridge=.64-fi*.1+.22*(fbm(vec2(x*(1.1+fi*.45)+fi*7.3+t*.006*(fi+1.),fi*3.1))-.5)*(1.-fi*.12)+.012*n(vec2(x*(10.+fi*5.),fi));
  vec3 col=mix(vec3(.26,.21,.31),vec3(.03,.04,.07),fi/4.);
  float mist=smoothstep(ridge-.14,ridge,uv.y)*(.45+.55*fbm(vec2(x*2.2-t*.035*(fi+1.),uv.y*6.+fi)));
  col=mix(col,vec3(.44,.36,.44),mist*.5*(1.-fi*.15));
  c=mix(c,col,smoothstep(ridge+.003,ridge-.003,uv.y));}
 return c;}
vec3 dunes(vec2 uv,float asp,float t,float L){float x=uv.x*asp;
 vec3 c=mix(mix(vec3(.13,.09,.17),vec3(.03,.035,.08),uv.y),mix(vec3(.99,.9,.83),vec3(.92,.93,.97),uv.y),L);
 c+=mix(vec3(.45,.3,.3),vec3(.06,.04,0.),L)*exp(-length(vec2(x-asp*.72,(uv.y-.8)*1.3))*5.)*.4;
 for(int i=0;i<5;i++){float fi=float(i);float fr=(fi+1.)*.55;float a=x*fr+fi*2.3+t*.015*(fi+1.);
  float ridge=.64-fi*.115+.07*sin(a)+.035*sin(a*2.3+1.)+.03*(fbm(vec2(x*fr*1.5,fi*4.))-.5);
  float lit=smoothstep(-.35,.35,cos(a)+.8*cos(a*2.3+1.));float dp=fi/4.;
  vec3 dk=mix(vec3(.17,.13,.2),vec3(.06,.05,.09),dp),dd=mix(vec3(.09,.07,.13),vec3(.02,.02,.04),dp);
  vec3 lk=mix(vec3(.98,.87,.78),vec3(.96,.77,.62),dp),ld=mix(vec3(.9,.77,.76),vec3(.8,.58,.52),dp);
  vec3 col=mix(mix(dd,dk,lit),mix(ld,lk,lit),L);
  col*=.86+.14*smoothstep(ridge-.16,ridge,uv.y);
  col*=1.-.035*(.5+.5*sin((uv.y-ridge)*380.+sin(x*26.+fi)*2.))*smoothstep(ridge,ridge-.08,uv.y);
  c=mix(c,col,smoothstep(ridge+.002,ridge-.002,uv.y));}
 return c;}
vec3 inkw(vec2 p,vec2 uv,float t,float L){vec2 q=p*1.2+vec2(t*.015,0.);
 float w=fbm(q+fbm(q*1.7-t*.02)*1.4);
 float a=smoothstep(.48,.72,w),e=smoothstep(.46,.5,w)*(1.-smoothstep(.5,.58,w));
 float r=smoothstep(.66,.74,fbm(q*.8+vec2(7.,3.)+t*.01));
 float g=n(uv*vec2(900.,700.))*.5+n(uv*vec2(160.,90.))*.5;
 vec3 pp=vec3(.955,.945,.915)-g*.03;
 vec3 lc=pp*(1.-a*.55*vec3(.8,.78,.74)-e*.22)*(1.-r*vec3(.05,.5,.55)*.55);
 vec3 dc=vec3(.025,.028,.035)+g*.01+vec3(.42,.46,.55)*a*.3+vec3(.6,.65,.75)*e*.16+vec3(.8,.25,.2)*r*.2;
 return mix(dc,lc,L);}
vec3 halftone(vec2 p,float t,float L){vec3 c=mix(vec3(.03,.03,.05),vec3(.965,.955,.935),L);
 for(int k=0;k<2;k++){float fk=float(k);float an=fk*.52;mat2 m=mat2(cos(an),-sin(an),sin(an),cos(an));
  vec2 g=m*p*34.+fk*.5;vec2 f=fract(g)-.5;
  float v=fbm(p*1.3+vec2(t*.03*(fk*2.-1.),t*.02)+fk*5.);float r=clamp((v-.3)*1.15,0.,.62);
  float d=length(f),aa=fwidth(d)*1.2,dt=smoothstep(r+aa,r-aa,d);
  vec3 ic=fk<.5?vec3(.95,.3,.55):vec3(.2,.45,.95);
  c=mix(c+ic*dt*.3,c*mix(vec3(1.),ic,dt*.85),L);}
 return c;}
vec3 ridges(vec2 uv,float asp,float t,float L){float x=uv.x*asp;vec3 bg=mix(vec3(.025,.03,.045),vec3(.955,.953,.945),L);vec3 c=bg;float px=1.5/R.y;
 float env=exp(-pow((x-asp*.5)*1.5,2.));
 for(int i=0;i<36;i++){float fi=float(i);float y0=.94-fi*.024;
  float s=n(vec2(x*5.,fi*1.3+t*.08))*.65+n(vec2(x*11.,fi*2.1-t*.06))*.35;
  float yl=y0+env*.14*s*s;
  c=mix(c,bg,smoothstep(yl+px*.5,yl-px*.5,uv.y));
  float ln=1.-smoothstep(px*.4,px*1.3,abs(uv.y-yl));
  vec3 lc=mix(mix(vec3(.45,.75,.85),vec3(.8,.6,.95),fi/35.)*.75,mix(vec3(.18,.24,.4),vec3(.55,.22,.4),fi/35.),L);
  c=mix(c,lc,ln);}
 return c;}
vec3 clouds(vec2 p,vec2 uv,float t,float L){vec2 q=p*1.1+vec2(t*.02,t*.006);float wq=fbm(q*.7-t*.01);
 float f=fbm(q+wq*.9),f2=fbm(q+wq*.9+vec2(.05,.04));
 float dn=smoothstep(.42,.78,f),sh=clamp((f-f2)*6.+.5,0.,1.);
 vec3 ds=mix(vec3(.035,.05,.1),vec3(.01,.015,.035),uv.y),ls=mix(vec3(.8,.88,.96),vec3(.66,.79,.93),uv.y);
 ds+=vec3(.25,.28,.35)*exp(-length(p-vec2(R.x/R.y*.78,.8))*7.)*.6;
 vec3 dc=mix(vec3(.07,.08,.13),vec3(.34,.38,.5),sh),lc=mix(vec3(.8,.84,.91),vec3(1.,.99,.97),sh);
 return mix(mix(ds,dc,dn),mix(ls,lc,dn),L);}
vec3 aqua(vec2 p,vec2 uv,float t,float L){float g=n(uv*vec2(700.,500.));
 vec3 c=mix(vec3(.03,.03,.045),vec3(.965,.955,.93)-g*.025,L);
 for(int k=0;k<3;k++){float fk=float(k);
  vec2 q=p*(1.1+fk*.25)+vec2(fk*4.1,fk*2.7)+vec2(sin(t*.03+fk),cos(t*.025+fk*2.))*.3;
  float f=fbm(q+fbm(q*2.+fk)*.5);
  float a=smoothstep(.52,.6,f),e=smoothstep(.52,.545,f)*(1.-smoothstep(.545,.6,f));
  vec3 pg=fk<.5?vec3(.3,.5,.85):fk<1.5?vec3(.92,.42,.5):vec3(.95,.72,.3);
  c=mix(c+pg*(a*.14+e*.28),c*(1.-(1.-pg)*(a*.4+e*.35)),L);}
 return c;}
void main(){vec2 uv=gl_FragCoord.xy/R;float asp=R.x/R.y;vec2 p=vec2(uv.x*asp,uv.y);vec3 c;float t=T;
 if(M<.5)c=aurora(p,t);else if(M<1.5)c=contour(p,t);else if(M<2.5)c=caustic(p,t);else if(M<3.5)c=nebula(p,t);
 else if(M<4.5)c=silk(uv,asp,t);else if(M<5.5)c=cells(p,t);else if(M<6.5)c=snow(uv,asp,t);else if(M<7.5)c=rain(p,t);
 else if(M<8.5)c=shore(uv,asp,t);else if(M<9.5)c=fireflies(p,uv,t);else if(M<10.5)c=golden(uv,p,t);else if(M<11.5)c=pond(p,uv,t);else if(M<12.5)c=beach(uv,asp,t);else if(M<13.5)c=mountains(uv,asp,t);
 else if(M<14.5)c=dunes(uv,asp,t,Lm);else if(M<15.5)c=inkw(p,uv,t,Lm);else if(M<16.5)c=halftone(p,t,Lm);else if(M<17.5)c=ridges(uv,asp,t,Lm);else if(M<18.5)c=clouds(p,uv,t,Lm);else c=aqua(p,uv,t,Lm);
 float nat=step(13.5,M)*step(.5,Lm);
 if(nat>.5){c=mix(vec3(.955),mix(vec3(.955),c,I*1.1),F);c=tint(c,.6);}else{
 c=mix(vec3(.03,.03,.04),c*I,F);
 c=tint(c,1.);}
 if(Lm>.5&&nat<.5){float l=dot(c,vec3(.299,.587,.114));float S=Hs>0.?Hs:1.;c=clamp(mix(vec3(.965,.965,.97),vec3(.83,.83,.845),S)+c*mix(.3,.7,S)+(c-l)*1.3,0.,1.);c=tint(c,.35);}
 c=max(c,0.);
 c+=(h(gl_FragCoord.xy+fract(T*7.))-.5)/160.;
 gl_FragColor=vec4(c,1.);}`;
