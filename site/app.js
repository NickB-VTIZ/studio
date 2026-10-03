'use strict';
const peek = document.querySelector('#peek');
const teaser = document.querySelector('#teaser');
peek.addEventListener('click', () => {
  const open = peek.getAttribute('aria-expanded') !== 'true';
  peek.setAttribute('aria-expanded', String(open));
  teaser.hidden = !open;
  peek.firstChild.textContent = open ? 'Tot binnenkort ' : 'Een klein voorproefje ';
});
document.querySelectorAll('[data-mood]').forEach(button => {
  button.addEventListener('click', () => {
    document.body.dataset.mood = button.dataset.mood;
    document.querySelectorAll('[data-mood]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  });
});
const card = document.querySelector('#card');
if (matchMedia('(hover: hover) and (prefers-reduced-motion: no-preference)').matches) {
  card.addEventListener('pointermove', event => {
    const bounds = card.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - .5;
    const y = (event.clientY - bounds.top) / bounds.height - .5;
    card.style.transform = `perspective(900px) rotate(-7deg) rotateY(${x * 10}deg) rotateX(${-y * 10}deg)`;
  });
  card.addEventListener('pointerleave', () => { card.style.transform = ''; });
}
