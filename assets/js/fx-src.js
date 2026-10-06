// Loony Games — общий набор анимаций для сайта (assets/js/fx.js).
// Собран из двух бесплатных open-source библиотек (лицензия MIT):
//   Motion   — https://motion.dev   (animate, inView, scroll, hover, press, spring)
//   anime.js — https://animejs.com  (splitText, scrambleText, stagger, timeline)
// Исходник: этот файл; сборка: esbuild --bundle --minify. В браузере всё доступно как window.LG.
import { animate, inView, scroll, hover, press, stagger as mStagger, spring } from 'motion';
import { animate as aAnimate } from 'animejs/animation';
import { createTimeline } from 'animejs/timeline';
import { stagger as aStagger } from 'animejs/utils';
import { splitText, scrambleText } from 'animejs/text';

window.LG = {
  motion: { animate, inView, scroll, hover, press, stagger: mStagger, spring },
  anime: { animate: aAnimate, createTimeline, stagger: aStagger, splitText, scrambleText },
  reduced: !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
};
document.dispatchEvent(new Event('lg:ready'));
