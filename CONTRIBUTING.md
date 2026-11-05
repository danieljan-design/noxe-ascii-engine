# Contributing

Thanks for wanting to help. Bug fixes, performance work, new glyph sets and new scenes are all welcome.

## Running it locally

```bash
python3 serve.py
```

Open http://localhost:5183. There is no build step and nothing to install. Edit a file, reload the page.

## Reporting a bug

Open an issue and include:

- what you did and what you expected to see;
- a screenshot or short recording;
- your browser, OS and GPU (open `chrome://gpu` in Chrome if you are not sure);
- any errors from the browser console.

Rendering problems often depend on the GPU, so that last part really helps.

## Making changes

1. Fork the repo and create a branch from `main`.
2. Keep the code plain: ES modules, no bundler, no new dependencies unless there is a strong reason.
3. Match the existing style: short functions, comments that explain *why*, and shader code kept in `engine/shaders.js`.
4. Check every scene still loads without console errors and runs smoothly, and that PNG export and recording still work if you touched the render passes.
5. Open a pull request with a short description and a before/after screenshot for anything visual.

## Adding a scene

See "Making scenes" in the [README](README.md). A good scene has:

- something moving, so the characters come alive (wind, water, particles);
- a clear silhouette against the background, so the edge glyphs have something to draw;
- glyph sets tagged on its materials, so each surface reads differently;
- a `frame` that looks good in both landscape and portrait.

Only include models, textures and references you made yourself or that have a license allowing redistribution, and credit them in your pull request.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
