import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TitleScanner, titleShowsWork } from '../src/main/termTitle.ts'

const osc = (title: string, end = '\x07'): string => `\x1b]0;${title}${end}`

test('titles measured from each CLI read as working or idle', () => {
  // Claude Code 2.1
  assert.equal(titleShowsWork('◐ Claude Code'), true)
  assert.equal(titleShowsWork('◑ Numbers one to sixty'), true)
  assert.equal(titleShowsWork('✳ Numbers one to sixty'), false)
  // Codex
  assert.equal(titleShowsWork('⠹ renaming... ⠹ | tchat'), true)
  assert.equal(titleShowsWork('List numbers one to sixty | tchat'), false)
  // Grok
  assert.equal(titleShowsWork('⠦ - Responding - grok'), true)
  assert.equal(titleShowsWork('English Words for Numbers One to Sixty - grok'), false)
  // a shell prompt's own title, and the blank braille cell
  assert.equal(titleShowsWork('achour@host:~/code'), false)
  assert.equal(titleShowsWork('⠀ blank'), false)
  assert.equal(titleShowsWork(''), false)
})

test('the scanner returns the last title in a chunk', () => {
  const scanner = new TitleScanner()
  assert.equal(scanner.feed(`text${osc('⠋ a')}more${osc('⠙ a')}`), '⠙ a')
  assert.equal(scanner.feed('plain output'), null)
  assert.equal(scanner.feed(`\x1b]2;st-terminated\x1b\\`), 'st-terminated')
})

test('a title split across chunks is found in the chunk that finishes it', () => {
  const scanner = new TitleScanner()
  assert.equal(scanner.feed('out\x1b]0;✳ Half'), null)
  assert.equal(scanner.feed(' done\x07after'), '✳ Half done')
  assert.equal(scanner.feed('out\x1b'), null)
  assert.equal(scanner.feed(']0;split escape\x07'), 'split escape')
})

test('other OSC sequences are neither titles nor carried', () => {
  const scanner = new TitleScanner()
  assert.equal(scanner.feed('\x1b]777;notify;x;{}\x07'), null)
  assert.equal(scanner.feed(osc('next')), 'next')
  assert.equal(scanner.feed('\x1b]7;file://host/tmp\x1b\\'), null)
})
