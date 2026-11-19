export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 sm:p-12">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-neutral-900 sm:text-4xl dark:text-neutral-100">
          GIF to WhatsApp Sticker
        </h1>
        <p className="text-base text-neutral-600 sm:text-lg dark:text-neutral-400">
          Turn Twitter/X GIFs into WhatsApp-compliant animated stickers and
          ready-to-share clips.
        </p>
        <div className="pt-4">
          <span className="inline-flex items-center rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            Conversion engine launching soon
          </span>
        </div>
      </div>
    </main>
  );
}
