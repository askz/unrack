<script lang="ts" generics="T extends string | number">
  // One of a few options as a row of buttons (the pressed one is the value).
  interface Props {
    options: readonly T[];
    value: T;
    label: (option: T) => string;
    onchange: (option: T) => void;
    ariaLabel: string;
    disabled?: boolean;
    title?: string;
  }

  let { options, value, label, onchange, ariaLabel, disabled = false, title }: Props = $props();
</script>

<div class="choice" role="group" aria-label={ariaLabel} {title}>
  {#each options as option (option)}
    <button type="button" class:primary={option === value} aria-pressed={option === value} {disabled}
            onclick={() => { if (option !== value) onchange(option); }}>{label(option)}</button>
  {/each}
</div>

<style>
  .choice { display: inline-flex; flex-wrap: wrap; gap: 2px; }
  .choice button { padding: 0 9px; }
</style>
