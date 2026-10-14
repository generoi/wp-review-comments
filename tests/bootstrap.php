<?php

/**
 * Unit tests run without WordPress: just enough of its functions for the pure
 * helpers under test.
 */

require_once dirname(__DIR__).'/vendor/autoload.php';

if (! defined('ABSPATH')) {
    define('ABSPATH', __DIR__.'/');
}

if (! function_exists('wp_parse_url')) {
    function wp_parse_url($url, $component = -1)
    {
        return parse_url($url, $component);
    }
}

if (! function_exists('wp_trim_words')) {
    function wp_trim_words($text, $num_words = 55, $more = null)
    {
        $words = preg_split('/\s+/', trim((string) $text));

        return count($words) > $num_words ? implode(' ', array_slice($words, 0, $num_words)).($more ?? '…') : implode(' ', $words);
    }
}

if (! function_exists('esc_url_raw')) {
    function esc_url_raw($url)
    {
        return (string) $url;
    }
}
