# Optional oil painting appearance

The default release is the neutral base interface. It contains no original team roster, avatars, personas or private records.

The separately downloadable `luma-oil-painting.zip` contains the reusable oil painting artwork and frontend appearance files. It keeps the same models, members, host, Broker and storage. It does not install a different backend or memory library.

1. Download the theme archive from the same GitHub Release as your source version.
2. Extract it so `themes/oil-painting/theme.json` exists.
3. Run:

```sh
npm run theme:apply
npm run build
npm start
```

`theme:apply` saves the corresponding base source files under `.local/base-theme`. It refuses to stack a second application over an existing one. Use only a trusted matching-version theme: frontend source is executable code.

To restore the base interface:

```sh
npm run theme:reset
npm run build
```

Reset restores overwritten base files. Extra, now-unreferenced artwork can remain; reset does not delete data or arbitrary consumer assets. The source archive and base Windows runtime do not automatically apply the theme. Building the executable after applying the theme creates your own themed runtime.

Original artwork and component styling are provided as an optional visual reference. Replacing the appearance is independent of configuring your agents, provider credentials and allowed working directories. Third-party font/effect notices remain with their corresponding files.
