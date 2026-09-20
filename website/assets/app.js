/*
 * AgentFlow 官网脚本 —— 原生 JavaScript，零依赖、零构建。
 * 只做两件事：导航高亮、回到顶部；不做任何网络请求。
 * 即使脚本被禁用，页面内容依然完整可读（渐进增强）。
 */
(function () {
  'use strict';

  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav-links a[href^="#"]'));
  var sections = navLinks
    .map(function (a) { return document.querySelector(a.getAttribute('href')); })
    .filter(Boolean);

  if (!('IntersectionObserver' in window) || sections.length === 0) return;

  var byId = {};
  navLinks.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      navLinks.forEach(function (a) { a.removeAttribute('aria-current'); });
      var active = byId[entry.target.id];
      if (active) active.setAttribute('aria-current', 'true');
    });
  }, { rootMargin: '-30% 0px -60% 0px', threshold: 0 });

  sections.forEach(function (s) { observer.observe(s); });
})();
