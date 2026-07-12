# Install Locations

## Default paths

| Item type | Default install path                  | Configured by                       |
| --------- | ------------------------------------- | ----------------------------------- |
| Block     | `compositions/<name>.html`            | `kenectai.json#paths.blocks`     |
| Component | `compositions/components/<name>.html` | `kenectai.json#paths.components` |

## How path remapping works

The `target` field in each item's `registry-item.json` specifies a default install path. The `add` command remaps the prefix based on `kenectai.json#paths`:

- Block targets starting with `compositions/` get remapped to `<paths.blocks>/`
- Component targets starting with `compositions/components/` get remapped to `<paths.components>/`

## kenectai.json

Created automatically by `kenectai init`. If it doesn't exist when you run `add`, the CLI creates it with defaults:

```json
{
  "$schema": "https://docs.kenectai.com/schema/kenectai.json",
  "registry": "https://raw.githubusercontent.com/sthuthillc/kenectai/main/registry",
  "paths": {
    "blocks": "compositions",
    "components": "compositions/components",
    "assets": "assets"
  }
}
```

## Custom layouts

To install blocks into a `scenes/` directory instead of `compositions/`:

```json
{
  "paths": {
    "blocks": "scenes"
  }
}
```

Then `kenectai add data-chart` writes to `scenes/data-chart.html` instead of `compositions/data-chart.html`. The snippet output reflects the remapped path.
