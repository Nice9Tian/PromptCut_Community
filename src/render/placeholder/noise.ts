// One immutable 16 × 16 image shared by every solid plane. The decoded RGBA tile is 1 KiB.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><path fill="#30343d" d="M0 0h16v16H0z"/><path fill="#3b404a" d="M1 0h1v1H1zM5 1h1v1H5zM12 0h1v1h-1zM8 2h1v1H8zM14 3h1v1h-1zM2 4h1v1H2zM10 4h1v1h-1zM6 5h1v1H6zM0 7h1v1H0zM13 7h1v1h-1zM3 9h1v1H3zM9 8h1v1H9zM15 10h1v1h-1zM6 11h1v1H6zM1 13h1v1H1zM11 12h1v1h-1zM4 15h1v1H4zM13 14h1v1h-1z"/><path fill="#262a32" d="M3 1h1v1H3zM10 0h1v1h-1zM0 3h1v1H0zM6 3h1v1H6zM12 5h1v1h-1zM4 6h1v1H4zM8 7h1v1H8zM15 6h1v1h-1zM2 8h1v1H2zM11 9h1v1h-1zM5 10h1v1H5zM0 11h1v1H0zM13 11h1v1h-1zM7 13h1v1H7zM2 14h1v1H2zM10 15h1v1h-1z"/></svg>`;

export const NOISE_TILE = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
