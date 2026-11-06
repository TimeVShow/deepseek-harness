/** CSS Modules typing for the panel's stylesheet. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css?inline' {
  const text: string
  export default text
}
