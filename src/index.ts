import Game from './game';
import Stats from 'stats.js';

const stats = new Stats();
document.body.appendChild(stats.dom);

const canvas = document.querySelector('canvas#main') as HTMLCanvasElement;
new Game(canvas, stats).start();
