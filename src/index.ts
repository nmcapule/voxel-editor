import Game from './game';
import Stats from 'stats.js';

const stats = new Stats();
document.body.appendChild(stats.dom);

const canvas = document.createElement('canvas');
canvas.style.width = '100%';
canvas.style.height = '100%';
document.body.appendChild(canvas);

new Game(canvas, stats).start();
