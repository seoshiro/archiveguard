declare module 'piexifjs' {
  export type ExifValue = number | string | number[] | number[][];
  export type ExifData = { '0th': Record<number, ExifValue>; Exif: Record<number, ExifValue>; GPS: Record<number, ExifValue>; Interop: Record<number, ExifValue>; '1st': Record<number, ExifValue>; thumbnail: string | null };
  const piexif: {
    load(data: string): ExifData;
    dump(data: ExifData): string;
    insert(exif: string, jpeg: string): string;
    TAGS: Record<string, Record<number, { name: string; type: string }>>;
  };
  export default piexif;
}
