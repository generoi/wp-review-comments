<?php

namespace GeneroWP\ReviewComments;

class Plugin
{
    /** @var class-string<Module>[] */
    public const MODULES = [
        Store::class,
        Rest::class,
        Abilities::class,
        Admin::class,
        Frontend::class,
    ];

    public const FILTER_MODULES = 'wp_review_comments_modules';

    public const TEXT_DOMAIN = 'wp-review-comments';

    protected static ?self $instance = null;

    /** @var array<class-string<Module>, Module> */
    protected array $modules = [];

    public static function getInstance(): self
    {
        return self::$instance ??= new self;
    }

    public function __construct()
    {
        add_action('plugins_loaded', [$this, 'boot']);
    }

    public function boot(): void
    {
        /** @var class-string<Module>[] $modules */
        $modules = apply_filters(self::FILTER_MODULES, self::MODULES);

        foreach ($modules as $class) {
            $this->modules[$class] = new $class;
            $this->modules[$class]->register();
        }
    }
}
