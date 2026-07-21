# Shared Layouts

## Root layout

- Path: `src/routes/+layout.svelte`
- Description: Loads the global theme and renders the active route without an additional shell.

```svelte
<script>
  import '../app.css';
</script>

<slot />
```

## Document shell

- Path: `src/app.html`
- Description: SvelteKit HTML document with a fluid body container.

```html
<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<link rel="icon" href="%sveltekit.assets%/favicon.png" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		%sveltekit.head%
	</head>
	<body data-sveltekit-preload-data="hover">
		<div style="display: contents">%sveltekit.body%</div>
	</body>
</html>
```

