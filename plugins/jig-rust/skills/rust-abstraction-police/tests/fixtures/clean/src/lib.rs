#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Percentage(u8);

#[derive(Debug)]
pub struct PercentageOutOfRange;

impl Percentage {
    pub fn new(value: u8) -> Result<Self, PercentageOutOfRange> {
        if value <= 100 {
            Ok(Self(value))
        } else {
            Err(PercentageOutOfRange)
        }
    }

    pub const fn get(self) -> u8 {
        self.0
    }
}

pub struct Names(Vec<String>);

impl Names {
    pub fn iter(&self) -> impl ExactSizeIterator<Item = &str> {
        self.0.iter().map(String::as_str)
    }
}

pub struct InternalStore {
    pool: sqlx::PgPool,
}

pub fn implementation_only_dependency() -> usize {
    let _query = sqlx::query("select 1");
    1
}
