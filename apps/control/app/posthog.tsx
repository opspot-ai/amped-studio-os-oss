/**
 * PostHog, staged. Mount by adding <PostHogSnippet /> inside the root layout body once the
 * purchase funnel is completable; instrumenting a funnel nobody can finish measures nothing.
 * Inline snippet, no dependency. One shared project across all six products, split on the
 * `product` property, so the register call is mandatory. It lives in the
 * loaded callback because a register() queued on the pre-load stub is silently wiped when the real
 * library loads: product would never reach super properties and product=gtm would return zero while
 * every capture still returned 200. Verification is product present in super properties, not a 200.
 */
export function PostHogSnippet() {
  const snippet = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once unregister identify alias reset group".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
posthog.init('phc_yshWfoMbuQ6JwUSYnbgQYfr7StfS2sGiCmpvUcHGh79o',{api_host:'https://us.i.posthog.com',person_profiles:'identified_only',loaded:function(ph){ph.register({product:'gtm'});}});`;
  return <script dangerouslySetInnerHTML={{ __html: snippet }} />;
}
