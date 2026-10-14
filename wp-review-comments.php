<?php

/*
Plugin Name:  Review Comments
Plugin URI:   https://github.com/generoi/wp-review-comments
Description:  Click-to-comment website review for clients and the team, readable by Claude through MCP.
Version:      0.4.0
Requires at least: 6.9
Requires PHP: 8.1
Author:       Genero
Author URI:   https://genero.fi/
License:      MIT
Text Domain:  wp-review-comments
*/

use GeneroWP\ReviewComments\Plugin;

if (! defined('ABSPATH')) {
    exit;
}

define('WP_REVIEW_COMMENTS_VERSION', '0.4.0');
define('WP_REVIEW_COMMENTS_FILE', __FILE__);

if (file_exists(__DIR__.'/vendor/autoload.php')) {
    require_once __DIR__.'/vendor/autoload.php';
}

// Installed without its own vendor/ and outside a site-wide composer install:
// load the classes from src/ directly rather than fatal.
if (! class_exists(Plugin::class)) {
    spl_autoload_register(static function (string $class): void {
        $prefix = 'GeneroWP\\ReviewComments\\';

        if (strncmp($class, $prefix, strlen($prefix)) !== 0) {
            return;
        }

        $file = __DIR__.'/src/'.str_replace('\\', '/', substr($class, strlen($prefix))).'.php';

        if (is_file($file)) {
            require_once $file;
        }
    });
}

Plugin::getInstance();
