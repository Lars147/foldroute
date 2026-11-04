declare module "virtual:foldroute-licenses" {
  const html: string;
  export default html;
}
declare module "virtual:foldroute-build-version" {
  const version: { readonly commit: string; readonly shortCommit: string };
  export default version;
}
